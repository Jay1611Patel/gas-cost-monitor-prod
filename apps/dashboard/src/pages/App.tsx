// apps/dashboard/src/pages/App.tsx
import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { SiweMessage } from 'siwe'
import { 
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, 
  BarChart, Bar, Legend, LineChart, Line, PieChart, Pie, Cell 
} from 'recharts'
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

// Stat Card Component
const StatCard = ({ title, value, change, changeType = 'neutral', icon }: any) => (
  <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-gray-600">{title}</p>
        <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
        {change && (
          <p className={`text-sm mt-1 ${
            changeType === 'positive' ? 'text-green-600' : 
            changeType === 'negative' ? 'text-red-600' : 'text-gray-600'
          }`}>
            {change}
          </p>
        )}
      </div>
      <div className="text-2xl">{icon}</div>
    </div>
  </div>
);

// Metric Card Component
const MetricCard = ({ title, children, className = '' }: any) => (
  <div className={`bg-white rounded-xl shadow-sm border border-gray-100 p-6 ${className}`}>
    <h3 className="text-lg font-semibold text-gray-900 mb-4">{title}</h3>
    {children}
  </div>
);

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
  
  // New state for enhanced dashboard
  const [dashboardStats, setDashboardStats] = useState({
    totalRepos: 0,
    totalReports: 0,
    totalContracts: 0,
    avgGasCost: 0,
    activeWatches: 0
  })
  const [reportTrends, setReportTrends] = useState<any[]>([])
  const [gasByContract, setGasByContract] = useState<any[]>([])
  const [recentActivity, setRecentActivity] = useState<any[]>([])
  const [selectedTimeRange, setSelectedTimeRange] = useState('7d')

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
      rows.push({ 
        key: k, 
        contract, 
        method, 
        left: l, 
        right: r, 
        delta: r - l,
        deltaPercent: l > 0 ? ((r - l) / l * 100).toFixed(1) : 'N/A'
      })
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
    loadDashboardStats()
  }, [token])

  // Load dashboard statistics
  const loadDashboardStats = async () => {
    try {
      // This would be enhanced with actual API endpoints for these stats
      const [reposRes, reportsRes, watchesRes] = await Promise.all([
        api.get('/repos', { headers }),
        api.get('/reports', { params: { limit: 1000 }, headers }),
        api.get('/onchain/watches', { headers })
      ])

      const totalRepos = reposRes.data.repos?.length || 0
      const totalReports = reportsRes.data.items?.length || 0
      const activeWatches = watchesRes.data.items?.filter((w: any) => w.active)?.length || 0
      
      // Calculate average gas cost from recent reports
      const recentReports = reportsRes.data.items?.slice(0, 10) || []
      let totalGas = 0
      let count = 0
      recentReports.forEach((report: any) => {
        if (Array.isArray(report.report)) {
          report.report.forEach((item: any) => {
            if (item.executionGasAverage) {
              totalGas += item.executionGasAverage
              count++
            }
          })
        }
      })
      const avgGasCost = count > 0 ? Math.round(totalGas / count) : 0

      setDashboardStats({
        totalRepos,
        totalReports,
        totalContracts: availableContracts.length,
        avgGasCost,
        activeWatches
      })

      // Generate trend data
      const trends = generateTrendData(reportsRes.data.items || [])
      setReportTrends(trends)

      // Generate gas by contract data
      const contractData = generateContractGasData(reportsRes.data.items || [])
      setGasByContract(contractData)

      // Recent activity
      setRecentActivity(recentReports.slice(0, 5))

    } catch (error) {
      console.error('Error loading dashboard stats:', error)
    }
  }

  // Generate trend data for charts
  const generateTrendData = (reports: any[]) => {
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date()
      date.setDate(date.getDate() - i)
      return date.toISOString().split('T')[0]
    }).reverse()

    return last7Days.map(date => {
      const dayReports = reports.filter(r => 
        new Date(r.createdAt).toISOString().split('T')[0] === date
      )
      
      let totalGas = 0
      let count = 0
      dayReports.forEach(report => {
        if (Array.isArray(report.report)) {
          report.report.forEach((item: any) => {
            if (item.executionGasAverage) {
              totalGas += item.executionGasAverage
              count++
            }
          })
        }
      })

      return {
        date,
        averageGas: count > 0 ? Math.round(totalGas / count) : 0,
        reportCount: dayReports.length
      }
    })
  }

  // Generate gas data by contract
  const generateContractGasData = (reports: any[]) => {
    const contractMap = new Map()
    
    reports.forEach(report => {
      if (Array.isArray(report.report)) {
        report.report.forEach((item: any) => {
          if (item.executionGasAverage && item.contract) {
            const existing = contractMap.get(item.contract) || { totalGas: 0, count: 0 }
            contractMap.set(item.contract, {
              totalGas: existing.totalGas + item.executionGasAverage,
              count: existing.count + 1
            })
          }
        })
      }
    })

    return Array.from(contractMap.entries()).map(([contract, data]) => ({
      contract,
      averageGas: Math.round(data.totalGas / data.count),
      reportCount: data.count
    })).sort((a, b) => b.averageGas - a.averageGas).slice(0, 10)
  }

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
            loadDashboardStats() // Refresh stats
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
        loadDashboardStats() // Refresh stats
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
      loadDashboardStats() // Refresh stats
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
      loadDashboardStats() // Refresh stats
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
      loadDashboardStats() // Refresh stats
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
        loadDashboardStats()
      }, 30000);
      return () => clearInterval(interval);
    }
  }, [token])

  // Prepare options for react-select
  const contractOptions = availableContracts.map(contract => ({
    value: contract.address,
    label: `${contract.address} (${contract.count} transactions)`
  }))

  // Colors for charts
  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D'];

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
        <div className="p-8 bg-white rounded-2xl shadow-xl w-full max-w-md text-center space-y-6">
          <div className="w-16 h-16 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center mx-auto">
            <span className="text-2xl text-white">⚡</span>
          </div>
          <h1 className="text-3xl font-bold text-gray-900">Gas Cost Monitor</h1>
          <p className="text-gray-600">Track, analyze, and optimize your smart contract gas usage</p>
          <button 
            onClick={login} 
            className="w-full px-4 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-medium rounded-lg hover:from-indigo-700 hover:to-purple-700 transition-all duration-300 shadow-lg hover:shadow-xl"
          >
            Connect Wallet
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center">
                <span className="text-white text-sm font-bold">G</span>
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Gas Monitor</h1>
                <p className="text-xs text-gray-500">Smart Contract Analytics</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-4">
              <div className="text-right">
                <p className="text-sm font-medium text-gray-900">Connected</p>
                <p className="text-xs text-gray-500 font-mono truncate max-w-[120px]">{address}</p>
              </div>
              <button 
                onClick={logout} 
                className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Dashboard Overview */}
        <section className="mb-8">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-gray-900">Dashboard Overview</h2>
            <select 
              value={selectedTimeRange}
              onChange={(e) => setSelectedTimeRange(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="24h">Last 24 Hours</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
            </select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">
            <StatCard 
              title="Connected Repos" 
              value={dashboardStats.totalRepos} 
              icon="📚"
            />
            <StatCard 
              title="Total Reports" 
              value={dashboardStats.totalReports} 
              icon="📊"
            />
            <StatCard 
              title="Avg Gas Cost" 
              value={dashboardStats.avgGasCost.toLocaleString()} 
              change="-2.3% from last week"
              changeType="positive"
              icon="⛽"
            />
            <StatCard 
              title="Watched Contracts" 
              value={dashboardStats.activeWatches} 
              icon="👁️"
            />
            <StatCard 
              title="Active Contracts" 
              value={availableContracts.length} 
              icon="📝"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <MetricCard title="Gas Cost Trends">
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={reportTrends}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line 
                      type="monotone" 
                      dataKey="averageGas" 
                      stroke="#3b82f6" 
                      strokeWidth={2}
                      name="Average Gas"
                    />
                    <Line 
                      type="monotone" 
                      dataKey="reportCount" 
                      stroke="#10b981" 
                      strokeWidth={2}
                      name="Report Count"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </MetricCard>

            <MetricCard title="Gas by Contract">
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={gasByContract}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="contract" angle={-45} textAnchor="end" height={80} />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="averageGas" fill="#3b82f6" name="Average Gas" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </MetricCard>
          </div>
        </section>

        {/* Recent Activity */}
        <section className="mb-8">
          <MetricCard title="Recent Activity">
            <div className="space-y-4">
              {recentActivity.map((activity, index) => (
                <div key={index} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                      <span className="text-blue-600 text-sm">📝</span>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {activity.owner}/{activity.repo}
                      </p>
                      <p className="text-xs text-gray-500">
                        Branch: {activity.branch} • {new Date(activity.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-gray-900">
                      {Array.isArray(activity.report) ? activity.report.length : 0} methods
                    </p>
                    <p className="text-xs text-gray-500">
                      {activity.prNumber ? `PR #${activity.prNumber}` : 'Main branch'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </MetricCard>
        </section>

        {/* Repository Management */}
        <section className="mb-8">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <MetricCard title="Connect Repository" className="h-fit">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Owner</label>
                  <input 
                    value={owner} 
                    onChange={e=>setOwner(e.target.value)} 
                    placeholder="openzeppelin" 
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Repository</label>
                  <input 
                    value={repo} 
                    onChange={e=>setRepo(e.target.value)} 
                    placeholder="openzeppelin-contracts" 
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Branch</label>
                  <input 
                    value={branch} 
                    onChange={e=>setBranch(e.target.value)} 
                    placeholder="main" 
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <button 
                  onClick={connectRepo} 
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
                >
                  Connect & Run Analysis
                </button>
              </div>
            </MetricCard>

            <MetricCard title="Latest Reports" className="lg:col-span-2">
              <div className="flex flex-wrap gap-4 mb-4 items-center">
                <select 
                  value={`${owner}/${repo}`} 
                  onChange={e=>{ const [o,r] = e.target.value.split('/'); setOwner(o||''); setRepo(r||'') }} 
                  className="border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="/">Select Repository</option>
                  {repos.map((r:any)=> (
                    <option key={`${r.owner}/${r.repo}`} value={`${r.owner}/${r.repo}`}>
                      {r.owner}/{r.repo}
                    </option>
                  ))}
                </select>
                <select 
                  value={branch} 
                  onChange={e=>setBranch(e.target.value)} 
                  className="border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">All Branches</option>
                  {branches.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              
              <div className="overflow-hidden border border-gray-200 rounded-lg">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Repository</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Branch</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PR</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {reports.map(r => (
                      <tr key={r._id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 text-sm font-mono text-gray-600">{r._id.substring(0, 6)}...</td>
                        <td className="px-4 py-3 text-sm text-gray-900">{r.owner}/{r.repo}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 font-mono">{r.branch}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{r.prNumber ?? '-'}</td>
                        <td className="px-4 py-3 text-sm text-gray-500">{new Date(r.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </MetricCard>
          </div>
        </section>

        {/* Report Comparison */}
        <section className="mb-8">
          <MetricCard title="Compare Reports">
            <div className="flex flex-col md:flex-row gap-4 mb-6">
              <select 
                value={left} 
                onChange={e=>setLeft(e.target.value)} 
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Select Baseline Report</option>
                {reports.map(r => (
                  <option key={r._id} value={r._id}>
                    {r.owner}/{r.repo}@{r.branch} — {new Date(r.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
              <select 
                value={right} 
                onChange={e=>setRight(e.target.value)} 
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Select Comparison Report</option>
                {reports.map(r => (
                  <option key={r._id} value={r._id}>
                    {r.owner}/{r.repo}@{r.branch} — {new Date(r.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
              <button 
                onClick={doCompare} 
                className="px-6 py-2 bg-gray-800 hover:bg-gray-900 text-white font-medium rounded-lg transition-colors"
              >
                Compare
              </button>
            </div>
            
            {comparison && (
              <div className="space-y-8">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={comparisonData.slice(0, 10)}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="key" angle={-45} textAnchor="end" height={80} />
                        <YAxis />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="left" name="Baseline Gas" fill="#64748b" />
                        <Bar dataKey="right" name="Comparison Gas" fill="#3b82f6" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={comparisonData.slice(0, 10)}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="key" angle={-45} textAnchor="end" height={80} />
                        <YAxis />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="delta" name="Gas Difference" fill="#dc2626" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                
                <div className="overflow-hidden border border-gray-200 rounded-lg">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Contract</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Baseline</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Comparison</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Difference</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Change %</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {comparisonData.map((row, index) => (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm font-mono text-gray-900">{row.contract}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{row.method}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">{row.left.toLocaleString()}</td>
                          <td className="px-4 py-3 text-sm text-gray-900">{row.right.toLocaleString()}</td>
                          <td className={`px-4 py-3 text-sm font-medium ${
                            row.delta > 0 ? 'text-red-600' : row.delta < 0 ? 'text-green-600' : 'text-gray-600'
                          }`}>
                            {row.delta > 0 ? '+' : ''}{row.delta.toLocaleString()}
                          </td>
                          <td className={`px-4 py-3 text-sm font-medium ${
                            row.delta > 0 ? 'text-red-600' : row.delta < 0 ? 'text-green-600' : 'text-gray-600'
                          }`}>
                            {row.deltaPercent}{row.deltaPercent !== 'N/A' ? '%' : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </MetricCard>
        </section>

        {/* On-chain Monitoring */}
        <section>
          <MetricCard title="On-chain Gas Monitoring">
            {/* Contract Selection Section */}
            <div className="mb-6 p-6 bg-gray-50 rounded-lg">
              <h3 className="font-semibold text-gray-900 mb-4">Contract Selection</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Choose from available contracts</label>
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
                    className="mt-2 px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 rounded transition-colors"
                  >
                    Refresh List
                  </button>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Or enter contract address</label>
                  <input 
                    value={onchainAddr} 
                    onChange={e => setOnchainAddr(e.target.value)} 
                    placeholder="0x..." 
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={handleLoadOnchain} 
                  disabled={loadingOnchain || !onchainAddr}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white font-medium rounded transition-colors"
                >
                  {loadingOnchain ? 'Loading...' : 'Load Data'}
                </button>
                
                <button 
                  onClick={addWatch} 
                  disabled={addingWatch || !onchainAddr}
                  className="px-4 py-2 bg-gray-800 hover:bg-gray-900 disabled:bg-gray-300 text-white font-medium rounded transition-colors"
                >
                  {addingWatch ? 'Adding...' : 'Add to Watch List'}
                </button>
              </div>
            </div>

            {/* Watched Contracts */}
            <div className="mb-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-gray-900">Watched Contracts</h3>
                <button onClick={loadWatches} className="px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 rounded text-gray-700 transition-colors">
                  Refresh
                </button>
              </div>
              
              {watches.length === 0 ? (
                <div className="text-center py-8 bg-gray-50 rounded-lg">
                  <p className="text-gray-500">No contracts being watched yet. Add a contract above.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {watches.map(w => (
                    <div key={w.contract} className={`p-4 border rounded-lg transition-colors ${
                      selectedWatch === w.contract ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                    }`}>
                      <div className="flex justify-between items-start">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-mono text-gray-900 truncate" title={w.contract}>
                            {w.contract}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {w.active ? '🟢 Active' : '🔴 Inactive'} • {new Date(w.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                        <div className="flex gap-1 ml-2">
                          <button 
                            onClick={() => handleSelectWatch(w.contract)}
                            className="px-2 py-1 text-xs bg-indigo-100 hover:bg-indigo-200 text-indigo-600 rounded"
                          >
                            Load
                          </button>
                          <button 
                            onClick={() => removeWatch(w.contract)}
                            className="px-2 py-1 text-xs bg-red-100 hover:bg-red-200 text-red-600 rounded"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* On-chain Data Visualization */}
            <div>
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-gray-900">
                  {selectedWatch ? `On-chain Data: ${selectedWatch}` : 
                    onchainAddr ? `On-chain Data: ${onchainAddr}` : 'Select a contract to view data'}
                </h3>
                {(selectedWatch || onchainAddr) && (
                  <button 
                    onClick={() => {
                      setSelectedWatch('');
                      setOnchainAddr('');
                      setOnchain([]);
                    }}
                    className="px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 rounded text-gray-700 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>

              {onchain.length > 0 ? (
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={onchain.slice().reverse()}>
                      <defs>
                        <linearGradient id="gasGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4}/>
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="blockNumber" />
                      <YAxis />
                      <Tooltip />
                      <Area 
                        type="monotone" 
                        dataKey="gasUsed" 
                        stroke="#3b82f6" 
                        fillOpacity={1} 
                        fill="url(#gasGradient)" 
                        name="Gas Used"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (selectedWatch || onchainAddr) ? (
                <div className="text-center py-12 bg-gray-50 rounded-lg">
                  <p className="text-gray-500">
                    {loadingOnchain ? 'Loading on-chain data...' : 'No recent on-chain activity for this contract.'}
                  </p>
                </div>
              ) : (
                <div className="text-center py-12 bg-gray-50 rounded-lg">
                  <p className="text-gray-500">Select or enter a contract address to view on-chain gas usage data.</p>
                </div>
              )}
            </div>
          </MetricCard>
        </section>
      </main>
    </div>
  )
}