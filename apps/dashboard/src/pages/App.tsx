import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { SiweMessage } from 'siwe'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, BarChart, Bar, Legend } from 'recharts'
import { ethers } from 'ethers'
import Select from 'react-select'

// Base URL for the API
const baseURL = window.location.hostname === 'localhost'
  ? 'http://localhost:4000'
  : 'http://api:4000'

const api = axios.create({ baseURL })

// Custom hook for authentication logic
function useAuth() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('jwt'))
  const [address, setAddress] = useState<string | null>(localStorage.getItem('address'))

  const headers = useMemo(() => token ? { Authorization: `Bearer ${token}` } : {}, [token])

  const login = async () => {
    if (!(window as any).ethereum) {
      alert('No wallet found. Please install MetaMask.');
      return;
    }
    try {
      const [addr] = await (window as any).ethereum.request({ method: 'eth_requestAccounts' })
      const checksummedAddr = ethers.getAddress(addr)
      const { data: { nonce } } = await api.post('/auth/nonce', { address: checksummedAddr })
      console.log('address: ', checksummedAddr);
      const msg = new SiweMessage({
        domain: window.location.host,
        address: checksummedAddr,
        statement: 'Sign in to Gas Cost Monitor',
        uri: window.location.origin,
        version: '1',
        chainId: 1,
        nonce,
      })
      const signature = await (window as any).ethereum.request({ method: 'personal_sign', params: [msg.prepareMessage(), addr] })
      const { data } = await api.post('/auth/verify', { message: msg, signature })
      localStorage.setItem('jwt', data.token)
      localStorage.setItem('address', data.address)
      setToken(data.token)
      setAddress(data.address)
    } catch (error) {
      console.error('Login failed:', error);
      alert('Failed to log in. Please try again.');
    }
  }

  const logout = () => {
    localStorage.removeItem('jwt');
    localStorage.removeItem('address');
    setToken(null); setAddress(null);
  }

  return { token, address, headers, login, logout }
}

export default function App() {
  const { token, address, headers, login, logout } = useAuth()
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [repos, setRepos] = useState<any[]>([])
  const [branches, setBranches] = useState<string[]>([])

  const [reports, setReports] = useState<any[]>([])
  const [left, setLeft] = useState<string>('')
  const [right, setRight] = useState<string>('')
  const [comparison, setComparison] = useState<any | null>(null)
  
  const comparisonData = useMemo(() => {
    if (!comparison?.left?.report || !comparison?.right?.report) return []
    const leftIdx: Record<string, number> = {}
    for (const item of comparison.left.report) {
      leftIdx[`${item.contract}.${item.method}`] = item.executionGasAverage
    }
    const keys = new Set<string>()
    for (const item of comparison.left.report) keys.add(`${item.contract}.${item.method}`)
    for (const item of comparison.right.report) keys.add(`${item.contract}.${item.method}`)
    const rows: any[] = []
    for (const k of keys) {
      const [contract, method] = k.split('.')
      const l = leftIdx[k] ?? 0
      const rItem = (comparison.right.report as any[]).find(x => `${x.contract}.${x.method}` === k)
      const r = rItem ? rItem.executionGasAverage : 0
      rows.push({ key: k, contract, method, left: l, right: r, delta: r - l })
    }
    return rows.sort((a,b)=> Math.abs(b.delta) - Math.abs(a.delta))
  }, [comparison])

  const [onchainAddr, setOnchainAddr] = useState('')
  const [onchain, setOnchain] = useState<any[]>([])
  const [watches, setWatches] = useState<any[]>([])
  const [selectedWatch, setSelectedWatch] = useState<string>('')
  const [loadingOnchain, setLoadingOnchain] = useState(false)
  const [addingWatch, setAddingWatch] = useState(false)
  const [availableContracts, setAvailableContracts] = useState<any[]>([])
  const [loadingContracts, setLoadingContracts] = useState(false)

  // Load repos on authentication
  useEffect(() => {
    if (!token) return
    api.get('/repos', { headers }).then(r => setRepos(r.data.repos || [])).catch(() => {})
  }, [token])

  // Load branches and reports when repo or branch changes
  useEffect(() => {
    if (!token) return
    if (owner && repo) {
      api.get('/branches', { params: { owner, repo }, headers }).then(r => setBranches(r.data.branches || [])).catch(() => setBranches([]))
      api.get('/reports', { params: { owner, repo, branch }, headers }).then(r => setReports(r.data.items || [])).catch(() => setReports([]))
    }
  }, [token, owner, repo, branch])

  // SSE auto-refresh
  useEffect(() => {
    if (!token) return
    const es = new EventSource(`${baseURL}/reports/stream?token=${encodeURIComponent(token)}`)
    
    es.onmessage = () => {}
    
    es.addEventListener('report', (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data)
        if (payload?.type === 'new-report') {
          const r = payload.report
          if (r.owner === owner && r.repo === repo && (!branch || r.branch === branch)) {
            api.get('/reports', { params: { owner, repo, branch }, headers }).then(res => setReports(res.data.items || []))
          }
        }
      } catch (error) {
        console.error('Error handling report event:', error)
      }
    })
    
    es.addEventListener('watch', async (ev: MessageEvent) => {
      try {
        await loadWatches()
        await loadAvailableContracts()
      } catch (error) {
        console.error('Error handling watch event:', error)
      }
    })
    
    es.addEventListener('onchain', async (ev: MessageEvent) => {
      try {
        const p = JSON.parse(ev.data)
        if (p?.contract && (p.contract === onchainAddr || p.contract === selectedWatch)) {
          await loadOnchainData(onchainAddr || selectedWatch);
        }
      } catch (error) {
        console.error('Error handling onchain event:', error)
      }
    })
    
    es.onerror = (error) => {
      console.error('SSE connection error:', error)
    }
    
    return () => es.close()
  }, [token, owner, repo, branch, onchainAddr, selectedWatch])

  const connectRepo = async () => {
    try {
      await api.post('/repos/connect', { owner, repo, defaultBranch: branch }, { headers })
      alert('Repo connected and initial gas run requested.')
    } catch (error) {
      console.error('Error connecting repo:', error)
      alert('Failed to connect repo. Please check the details and try again.')
    }
  }

  const doCompare = async () => {
    if (!left || !right) return
    try {
      const { data } = await api.get('/reports/compare', { params: { leftId: left, rightId: right }, headers })
      setComparison(data)
    } catch (error) {
      console.error('Error comparing reports:', error)
      alert('Failed to compare reports.')
    }
  }

  const loadOnchainData = async (contractAddress: string) => {
    if (!contractAddress) return
    setLoadingOnchain(true)
    try {
      const { data } = await api.get(`/onchain/${contractAddress}`, { headers })
      setOnchain(data.items || [])
    } catch (error) {
      console.error('Error loading onchain data:', error)
      alert('Error loading on-chain data. Please check the contract address and try again.')
    } finally {
      setLoadingOnchain(false)
    }
  }

  const loadAvailableContracts = async () => {
    if (!token) return
    setLoadingContracts(true)
    try {
      const { data } = await api.get('/internal/onchain/contracts', { headers })
      setAvailableContracts(data.contracts || [])
    } catch (error) {
      console.error('Error loading available contracts:', error)
    } finally {
      setLoadingContracts(false)
    }
  }

  const handleContractSelect = (selectedOption: any) => {
    if (selectedOption) {
      setOnchainAddr(selectedOption.value)
    } else {
      setOnchainAddr('')
    }
  }

  const handleLoadOnchain = async () => {
    if (!onchainAddr) {
      alert('Please select or enter a contract address');
      return
    }
    const normalizedAddr = onchainAddr.toLowerCase();
    await loadOnchainData(normalizedAddr);
  }

  const handleSelectWatch = async (contract: string) => {
    setSelectedWatch(contract);
    setOnchainAddr(contract);
    await loadOnchainData(contract);
  }

  const loadWatches = async () => {
    try {
      const { data } = await api.get('/onchain/watches', { headers })
      setWatches(data.items || [])
    } catch (error) {
      console.error('Error loading watches:', error)
    }
  }

  const addWatch = async () => {
    if (!onchainAddr) {
      alert('Please select or enter a contract address');
      return
    }
    setAddingWatch(true)
    try {
      const normalizedAddr = onchainAddr.toLowerCase();
      await api.post('/onchain/watches', { contract: normalizedAddr }, { headers })
      setOnchainAddr('')
      await loadWatches()
      await loadAvailableContracts()
      alert(`Contract ${normalizedAddr} added to watch list`);
    } catch (error: any) {
      console.error('Error adding watch:', error)
      if (error.response?.data?.error) {
        alert(`Error: ${error.response.data.error}`);
      } else {
        alert('Error adding contract to watch list');
      }
    } finally {
      setAddingWatch(false)
    }
  }

  const removeWatch = async (contract: string) => {
    if (!confirm(`Are you sure you want to remove ${contract} from your watch list?`)) {
      return
    }
    try {
      const normalizedAddr = contract.toLowerCase();
      await api.delete(`/onchain/watches/${normalizedAddr}`, { headers })
      await loadWatches()
      await loadAvailableContracts()
      if (selectedWatch === normalizedAddr) {
        setSelectedWatch('')
        setOnchainAddr('')
        setOnchain([])
      }
      alert(`Contract ${normalizedAddr} removed from watch list`);
    } catch (error: any) {
      console.error('Error removing watch:', error)
      if (error.response?.data?.error) {
        alert(`Error: ${error.response.data.error}`);
      } else {
        alert('Error removing contract from watch list');
      }
    }
  }

  // Initial and periodic data load
  useEffect(() => { 
    if (token) {
      loadWatches()
      loadAvailableContracts()
      const interval = setInterval(() => {
        loadWatches()
        loadAvailableContracts()
      }, 30000);
      return () => clearInterval(interval);
    }
  }, [token])

  // Prepare options for react-select
  const contractOptions = availableContracts.map(contract => ({
    value: contract.address,
    label: `${contract.address} (${contract.count} transactions)`
  }))

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="p-8 bg-white rounded-xl shadow-lg w-full max-w-sm text-center space-y-6">
          <h1 className="text-3xl font-bold text-gray-800">Gas Cost Monitor</h1>
          <p className="text-gray-600">Securely sign in with your Ethereum wallet to get started.</p>
          <button onClick={login} className="w-full px-4 py-3 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 transition-colors duration-300">
            Connect Wallet
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-8 space-y-8 bg-gray-100 font-sans">
      <div className="flex items-center justify-between pb-4 border-b border-gray-200">
        <div className="flex items-center gap-2 text-gray-700 text-lg font-medium">
          <span className="text-2xl">📈</span>
          <span className="hidden sm:inline">Gas Dashboard</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-gray-600 text-sm font-mono truncate">{address}</span>
          <button onClick={logout} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-100 transition-colors">
            Logout
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Connect Repo Card */}
        <div className="p-6 bg-white rounded-xl shadow-lg h-full">
          <h2 className="font-bold text-xl text-gray-800 mb-4">Connect GitHub Repo</h2>
          <div className="space-y-4">
            <input value={owner} onChange={e=>setOwner(e.target.value)} placeholder="owner (e.g., openzeppelin)" className="w-full border border-gray-300 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <input value={repo} onChange={e=>setRepo(e.target.value)} placeholder="repo (e.g., openzeppelin-contracts)" className="w-full border border-gray-300 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <input value={branch} onChange={e=>setBranch(e.target.value)} placeholder="default branch (e.g., main)" className="w-full border border-gray-300 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button onClick={connectRepo} className="w-full px-4 py-3 bg-indigo-600 hover:bg-indigo-700 transition-colors text-white font-medium rounded-lg">
              Connect & Run
            </button>
          </div>
        </div>

        {/* Latest Reports Card */}
        <div className="p-6 bg-white rounded-xl shadow-lg lg:col-span-2">
          <h2 className="font-bold text-xl text-gray-800 mb-4">Latest Reports</h2>
          <div className="flex flex-wrap gap-4 mb-4 items-center">
            <select value={`${owner}/${repo}`} onChange={e=>{ const [o,r] = e.target.value.split('/'); setOwner(o||''); setRepo(r||'') }} className="border border-gray-300 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="/">Select Repo</option>
              {repos.map((r:any)=> (
                <option key={`${r.owner}/${r.repo}`} value={`${r.owner}/${r.repo}`}>{r.owner}/{r.repo}</option>
              ))}
            </select>
            <select value={branch} onChange={e=>setBranch(e.target.value)} className="border border-gray-300 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">All Branches</option>
              {branches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-gray-500 border-b border-gray-200">
                <tr>
                  <th className="p-3">ID</th>
                  <th className="p-3">Repository</th>
                  <th className="p-3">Branch</th>
                  <th className="p-3">PR</th>
                  <th className="p-3">Date</th>
                </tr>
              </thead>
              <tbody>
                {reports.map(r => (
                  <tr key={r._id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="p-3 text-gray-600 font-mono text-xs">{r._id.substring(0, 6)}...</td>
                    <td className="p-3 text-gray-800">{r.owner}/{r.repo}</td>
                    <td className="p-3 text-gray-600 font-mono text-xs">{r.branch}</td>
                    <td className="p-3 text-gray-600">{r.prNumber ?? '-'}</td>
                    <td className="p-3 text-gray-600 text-xs">{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="p-6 bg-white rounded-xl shadow-lg">
        <h2 className="font-bold text-xl text-gray-800 mb-4">Compare Reports</h2>
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <select value={left} onChange={e=>setLeft(e.target.value)} className="border border-gray-300 p-3 rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">Select Left Report</option>
            {reports.map(r => <option key={r._id} value={r._id}>{r.owner}/{r.repo}@{r.branch} — {new Date(r.createdAt).toLocaleString()}</option>)}
          </select>
          <select value={right} onChange={e=>setRight(e.target.value)} className="border border-gray-300 p-3 rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">Select Right Report</option>
            {reports.map(r => <option key={r._id} value={r._id}>{r.owner}/{r.repo}@{r.branch} — {new Date(r.createdAt).toLocaleString()}</option>)}
          </select>
          <button onClick={doCompare} className="px-5 py-3 bg-gray-800 hover:bg-gray-900 transition-colors text-white font-medium rounded-lg">
            Compare
          </button>
        </div>
        {comparison && (
          <div className="space-y-8">
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={comparisonData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="key" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={70} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="left" name="Left Avg Gas" fill="#64748b" />
                  <Bar dataKey="right" name="Right Avg Gas" fill="#3b82f6" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="h-60 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={comparisonData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="key" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={70} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="delta" name="Delta (Right-Left)" fill="#dc2626" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      <div className="p-6 bg-white rounded-xl shadow-lg">
        <h2 className="font-bold text-xl text-gray-800 mb-4">On-chain Gas Usage</h2>
        
        {/* Contract Selection Section */}
        <div className="mb-6 p-5 bg-gray-50 rounded-lg">
          <h3 className="font-semibold text-gray-700 mb-3">Select Contract</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {/* Contract Dropdown */}
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">Choose from available contracts</label>
              <Select
                options={contractOptions}
                onChange={handleContractSelect}
                placeholder="Select a contract..."
                isClearable
                isLoading={loadingContracts}
                className="react-select-container"
                classNamePrefix="react-select"
              />
              <button 
                onClick={loadAvailableContracts}
                className="mt-2 px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition-colors"
              >
                Refresh List
              </button>
            </div>

            {/* Manual Input */}
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">Or enter a contract address</label>
              <input 
                value={onchainAddr} 
                onChange={e => setOnchainAddr(e.target.value)} 
                placeholder="0x..." 
                className="w-full border border-gray-300 p-3 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-4">
            <button 
              onClick={handleLoadOnchain} 
              disabled={loadingOnchain || !onchainAddr}
              className="px-5 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-500 transition-colors text-white font-medium rounded-lg"
            >
              {loadingOnchain ? 'Loading...' : 'Load Data'}
            </button>
            
            <button 
              onClick={addWatch} 
              disabled={addingWatch || !onchainAddr}
              className="px-5 py-3 bg-gray-800 hover:bg-gray-900 disabled:bg-gray-300 disabled:text-gray-500 transition-colors text-white font-medium rounded-lg"
            >
              {addingWatch ? 'Adding...' : 'Add to Watch List'}
            </button>
          </div>
        </div>

        {/* Watched Contracts Section */}
        <div className="mb-6 p-5 bg-gray-50 rounded-lg">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-gray-700">Your Watched Contracts</h3>
            <button onClick={loadWatches} className="px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 rounded-md text-gray-700 transition-colors">
              Refresh
            </button>
          </div>
          
          {watches.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-gray-500 text-sm">No contracts being watched yet. Add a contract above.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {watches.map(w => (
                <div key={w.contract} className={`p-4 border rounded-lg flex justify-between items-center transition-colors ${
                  selectedWatch === w.contract ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                }`}>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-mono truncate text-gray-800" title={w.contract}>
                      {w.contract}
                    </div>
                    <div className="text-xs text-gray-500">
                      {w.active ? '✅ Active' : '❌ Inactive'} • {new Date(w.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex gap-2 ml-2">
                    <button 
                      onClick={() => handleSelectWatch(w.contract)}
                      className="px-2 py-1 text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-600 rounded-md"
                    >
                      Load
                    </button>
                    <button 
                      onClick={() => removeWatch(w.contract)}
                      className="px-2 py-1 text-xs bg-red-100 hover:bg-red-200 text-red-600 rounded-md"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* On-chain Data Chart */}
        <div className="mb-4">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-gray-700">
              {selectedWatch ? `On-chain Data for ${selectedWatch}` : 
                onchainAddr ? `On-chain Data for ${onchainAddr}` : 'Select a contract to view data'}
            </h3>
            {(selectedWatch || onchainAddr) && (
              <button 
                onClick={() => {
                  setSelectedWatch('');
                  setOnchainAddr('');
                  setOnchain([]);
                }}
                className="px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 rounded-md text-gray-700 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {onchain.length > 0 ? (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={onchain.slice().reverse()}>
                <defs>
                  <linearGradient id="c" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="blockNumber" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Area type="monotone" dataKey="gasUsed" stroke="#2563eb" fillOpacity={1} fill="url(#c)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (selectedWatch || onchainAddr) ? (
          <div className="text-sm text-gray-500 mt-2 p-4 bg-gray-50 rounded-lg text-center">
            {loadingOnchain ? 'Loading on-chain data...' : 'No on-chain activity for this contract in recent history.'}
          </div>
        ) : (
          <div className="text-sm text-gray-500 mt-2 p-4 bg-gray-50 rounded-lg text-center">
            Please select or enter a contract to view on-chain gas usage data.
          </div>
        )}
      </div>
    </div>
  )
}