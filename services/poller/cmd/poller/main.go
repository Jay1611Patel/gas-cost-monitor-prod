package main

import (
	contextpkg "context"
	encodingjson "encoding/json"
	hexpkg "encoding/hex"
	iopkg "io"
	logpkg "log"
	mathbig "math/big"
	nethttppkg "net/http"
	ospkg "os"
	stringspkg "strings"
	syncpkg "sync"
	timepkg "time"

	"github.com/IBM/sarama"
	"github.com/ethereum/go-ethereum/ethclient"
	typespkg "github.com/ethereum/go-ethereum/core/types"
	"github.com/joho/godotenv"
)

func getenv(key, def string) string {
	v := ospkg.Getenv(key)
	if v == "" {
		return def
	}
	return v
}

type WatchManager struct {
	targets map[string]map[string]bool // tenantId -> contractAddress -> active
	mu      syncpkg.RWMutex
}

func NewWatchManager() *WatchManager {
	return &WatchManager{
		targets: make(map[string]map[string]bool),
	}
}

func (wm *WatchManager) AddWatch(tenantId, contract string) {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	
	if _, exists := wm.targets[tenantId]; !exists {
		wm.targets[tenantId] = make(map[string]bool)
	}
	wm.targets[tenantId][stringspkg.ToLower(contract)] = true
}

func (wm *WatchManager) RemoveWatch(tenantId, contract string) {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	
	if tenantWatches, exists := wm.targets[tenantId]; exists {
		delete(tenantWatches, stringspkg.ToLower(contract))
		if len(tenantWatches) == 0 {
			delete(wm.targets, tenantId)
		}
	}
}

func (wm *WatchManager) GetWatchesForContract(contract string) []string {
	wm.mu.RLock()
	defer wm.mu.RUnlock()
	
	contractLower := stringspkg.ToLower(contract)
	var tenants []string
	
	for tenantId, watches := range wm.targets {
		if watches[contractLower] {
			tenants = append(tenants, tenantId)
		}
	}
	
	return tenants
}

func (wm *WatchManager) GetAllWatches() map[string]map[string]bool {
	wm.mu.RLock()
	defer wm.mu.RUnlock()
	
	// Return a copy to avoid race conditions
	result := make(map[string]map[string]bool)
	for tenantId, watches := range wm.targets {
		result[tenantId] = make(map[string]bool)
		for contract, active := range watches {
			result[tenantId][contract] = active
		}
	}
	return result
}

func main() {
	_ = godotenv.Load()
	broker := getenv("KAFKA_BROKER", "kafka:9092")
	topic := getenv("KAFKA_TOPIC", "onchain-gas")
	rpcURL := getenv("ETH_RPC_URL", "")
	apiBase := getenv("API_BASE", "http://api:4000")

	if rpcURL == "" {
		logpkg.Fatal("ETH_RPC_URL is required")
	}

	watchManager := NewWatchManager()

	// Bootstrap existing watches from API
	func() {
		logpkg.Println("Bootstrapping existing watches from API...")
		req, err := nethttppkg.NewRequest("GET", apiBase+"/internal/onchain/watches", nil)
		if err != nil {
			logpkg.Printf("Error creating bootstrap request: %v", err)
			return
		}
		
		resp, err := nethttppkg.DefaultClient.Do(req)
		if err != nil {
			logpkg.Printf("Error bootstrapping watches: %v", err)
			return
		}
		defer resp.Body.Close()
		
		if resp.StatusCode != nethttppkg.StatusOK {
			logpkg.Printf("Bootstrap API returned status: %d", resp.StatusCode)
			return
		}
		
		body, err := iopkg.ReadAll(resp.Body)
		if err != nil {
			logpkg.Printf("Error reading bootstrap response: %v", err)
			return
		}
		
		var out struct {
			Items []struct {
				TenantId string `json:"tenantId"`
				Contract string `json:"contract"`
			} `json:"items"`
		}
		
		if err := encodingjson.Unmarshal(body, &out); err != nil {
			logpkg.Printf("Error parsing bootstrap response: %v", err)
			return
		}
		
		for _, item := range out.Items {
			watchManager.AddWatch(item.TenantId, item.Contract)
		}
		logpkg.Printf("Loaded %d watches from API", len(out.Items))
	}()

	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		logpkg.Fatalf("Failed to dial RPC: %v", err)
	}
	defer client.Close()

	// Kafka producer setup
	cfg := sarama.NewConfig()
	cfg.Producer.Return.Successes = true
	producer, err := sarama.NewSyncProducer([]string{broker}, cfg)
	if err != nil {
		logpkg.Fatalf("Failed to create Kafka producer: %v", err)
	}
	defer producer.Close()

	// Kafka consumer for watch requests
	cfgC := sarama.NewConfig()
	cfgC.Consumer.Group.Rebalance.Strategy = sarama.BalanceStrategyRoundRobin
	consumer, err := sarama.NewConsumerGroup([]string{broker}, "onchain-watchers", cfgC)
	if err != nil {
		logpkg.Fatalf("Failed to create Kafka consumer: %v", err)
	}
	defer consumer.Close()

	// Start consumer for watch requests
	go func() {
		handler := &consumerGroupHandler{watchManager: watchManager}
		for {
			err := consumer.Consume(contextpkg.Background(), []string{"onchain-watch-requests"}, handler)
			if err != nil {
				logpkg.Printf("Consumer error: %v", err)
				timepkg.Sleep(2 * timepkg.Second)
			}
		}
	}()

	ctx := contextpkg.Background()
	chainID, err := client.NetworkID(ctx)
	if err != nil {
		logpkg.Fatalf("Failed to get network ID: %v", err)
	}

	// Initialize last block to current head
	head, err := client.BlockByNumber(ctx, nil)
	if err != nil {
		logpkg.Fatalf("Failed to get head block: %v", err)
	}
	last := head.Number().Uint64()
	logpkg.Printf("Starting from block %d", last)

	for {
		head, err := client.BlockByNumber(ctx, nil)
		if err != nil {
			logpkg.Printf("Error getting latest block: %v", err)
			timepkg.Sleep(3 * timepkg.Second)
			continue
		}

		currentBlock := head.Number().Uint64()
		if currentBlock <= last {
			timepkg.Sleep(2 * timepkg.Second)
			continue
		}

		logpkg.Printf("Processing blocks %d to %d", last+1, currentBlock)
		
		for bn := last + 1; bn <= currentBlock; bn++ {
			blk, err := client.BlockByNumber(ctx, mathbig.NewInt(int64(bn)))
			if err != nil {
				logpkg.Printf("Error getting block %d: %v", bn, err)
				continue
			}

			logpkg.Printf("Processing block %d with %d transactions", bn, len(blk.Transactions()))

			for _, tx := range blk.Transactions() {
				if tx.To() == nil { // Skip contract creation transactions
					continue
				}

				to := stringspkg.ToLower(tx.To().Hex())
				tenants := watchManager.GetWatchesForContract(to)

				if len(tenants) == 0 {
					continue
				}

				rec, err := client.TransactionReceipt(ctx, tx.Hash())
				if err != nil {
					logpkg.Printf("Error getting receipt for tx %s: %v", tx.Hash().Hex(), err)
					continue
				}

				from := ""
				if tx != nil {
					signer := typespkg.LatestSignerForChainID(chainID)
					addr, err := typespkg.Sender(signer, tx)
					if err == nil {
						from = stringspkg.ToLower(addr.Hex())
					}
				}

				methodSig := ""
				if data := tx.Data(); len(data) >= 4 {
					methodSig = "0x" + hexpkg.EncodeToString(data[:4])
				}

				// Calculate fees
				effPriceWei := new(mathbig.Int)
				if rec.EffectiveGasPrice != nil {
					effPriceWei = rec.EffectiveGasPrice
				} else if tx.GasPrice() != nil {
					effPriceWei = tx.GasPrice()
				}

				baseFeeWei := blk.BaseFee()
				priorityWei := new(mathbig.Int).Sub(effPriceWei, baseFeeWei)
				if priorityWei.Sign() < 0 {
					priorityWei = mathbig.NewInt(0)
				}

				// Convert to gwei floats
				gweiDiv := mathbig.NewFloat(1e9)
				effGwei := new(mathbig.Float).Quo(new(mathbig.Float).SetInt(effPriceWei), gweiDiv)
				baseGwei := new(mathbig.Float).Quo(new(mathbig.Float).SetInt(baseFeeWei), gweiDiv)
				prioGwei := new(mathbig.Float).Quo(new(mathbig.Float).SetInt(priorityWei), gweiDiv)
				
				effGweiF, _ := effGwei.Float64()
				baseGweiF, _ := baseGwei.Float64()
				prioGweiF, _ := prioGwei.Float64()

				// Calculate cost in ETH
				weiPerEth := mathbig.NewFloat(1e18)
				gasUsedF := new(mathbig.Float).SetInt64(int64(rec.GasUsed))
				costWeiF := new(mathbig.Float).Mul(new(mathbig.Float).SetInt(effPriceWei), gasUsedF)
				costEthF := new(mathbig.Float).Quo(costWeiF, weiPerEth)
				costEth, _ := costEthF.Float64()

				// Send message for each tenant watching this contract
				for _, tenantId := range tenants {
					payload := map[string]any{
						"tenantId":              tenantId,
						"contract":              to,
						"txHash":                tx.Hash().Hex(),
						"blockNumber":           blk.Number().Uint64(),
						"timestamp":             blk.Time(),
						"from":                  from,
						"to":                    to,
						"methodSignature":       methodSig,
						"gasUsed":               rec.GasUsed,
						"effectiveGasPriceGwei": effGweiF,
						"baseFeeGwei":           baseGweiF,
						"priorityFeeGwei":       prioGweiF,
						"costEth":               costEth,
					}

					value, err := encodingjson.Marshal(payload)
					if err != nil {
						logpkg.Printf("Error marshaling payload: %v", err)
						continue
					}

					msg := &sarama.ProducerMessage{
						Topic: topic,
						Value: sarama.ByteEncoder(value),
					}

					_, _, err = producer.SendMessage(msg)
					if err != nil {
						logpkg.Printf("Error sending Kafka message: %v", err)
					} else {
						logpkg.Printf("Sent onchain data for tenant %s, contract %s, tx %s", tenantId, to, tx.Hash().Hex())
					}

					// Update watch status (best effort)
					go func(tenantId, contract string) {
						statusPayload := map[string]string{
							"tenantId": tenantId,
							"contract": contract,
						}
						statusJSON, _ := encodingjson.Marshal(statusPayload)
						
						resp, err := nethttppkg.Post(apiBase+"/internal/onchain/status", "application/json", stringspkg.NewReader(string(statusJSON)))
						if err != nil {
							logpkg.Printf("Error updating watch status: %v", err)
							return
						}
						defer resp.Body.Close()
					}(tenantId, to)
				}
			}
		}

		last = currentBlock
	}
}

type consumerGroupHandler struct {
	watchManager *WatchManager
}

func (h *consumerGroupHandler) Setup(s sarama.ConsumerGroupSession) error {
	logpkg.Println("Consumer group setup completed")
	return nil
}

func (h *consumerGroupHandler) Cleanup(s sarama.ConsumerGroupSession) error {
	logpkg.Println("Consumer group cleanup completed")
	return nil
}

func (h *consumerGroupHandler) ConsumeClaim(s sarama.ConsumerGroupSession, c sarama.ConsumerGroupClaim) error {
	for msg := range c.Messages() {
		var payload struct {
			TenantId string `json:"tenantId"`
			Contract string `json:"contract"`
			Action   string `json:"action"`
		}
		
		if err := encodingjson.Unmarshal(msg.Value, &payload); err != nil {
			logpkg.Printf("Error unmarshaling watch request: %v", err)
			s.MarkMessage(msg, "")
			continue
		}

		logpkg.Printf("Received watch request: %s %s for tenant %s", payload.Action, payload.Contract, payload.TenantId)

		switch payload.Action {
		case "add":
			h.watchManager.AddWatch(payload.TenantId, payload.Contract)
		case "remove":
			h.watchManager.RemoveWatch(payload.TenantId, payload.Contract)
		default:
			logpkg.Printf("Unknown action: %s", payload.Action)
		}

		s.MarkMessage(msg, "")
	}
	return nil
}