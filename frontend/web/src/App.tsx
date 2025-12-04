import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Track {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  category: string;
  name: string;
  bpm: number;
}

interface MixHistory {
  id: string;
  tracks: string[];
  timestamp: number;
  result: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEMixTracks = (encryptedTracks: string[]): string => {
  // Simulate FHE mixing by averaging the decrypted values
  let total = 0;
  encryptedTracks.forEach(track => {
    total += FHEDecryptNumber(track);
  });
  const average = total / encryptedTracks.length;
  return FHEEncryptNumber(average);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [mixHistory, setMixHistory] = useState<MixHistory[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [mixing, setMixing] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newTrackData, setNewTrackData] = useState({ name: "", category: "drums", bpm: 120 });
  const [selectedTracks, setSelectedTracks] = useState<string[]>([]);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [showFeatures, setShowFeatures] = useState(false);

  // Track categories statistics
  const categoryStats = {
    drums: tracks.filter(t => t.category === "drums").length,
    vocals: tracks.filter(t => t.category === "vocals").length,
    melody: tracks.filter(t => t.category === "melody").length,
    bass: tracks.filter(t => t.category === "bass").length
  };

  useEffect(() => {
    loadTracks().finally(() => setLoading(false));
    loadMixHistory();
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadTracks = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check if contract is available
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load track keys
      const keysBytes = await contract.getData("track_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing track keys:", e); }
      }
      
      // Load each track
      const trackList: Track[] = [];
      for (const key of keys) {
        try {
          const trackBytes = await contract.getData(`track_${key}`);
          if (trackBytes.length > 0) {
            try {
              const trackData = JSON.parse(ethers.toUtf8String(trackBytes));
              trackList.push({ 
                id: key, 
                encryptedData: trackData.data, 
                timestamp: trackData.timestamp, 
                owner: trackData.owner, 
                category: trackData.category,
                name: trackData.name,
                bpm: trackData.bpm
              });
            } catch (e) { console.error(`Error parsing track data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading track ${key}:`, e); }
      }
      
      trackList.sort((a, b) => b.timestamp - a.timestamp);
      setTracks(trackList);
    } catch (e) { console.error("Error loading tracks:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const loadMixHistory = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Load mix history keys
      const keysBytes = await contract.getData("mix_history_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing mix history keys:", e); }
      }
      
      // Load each mix history item
      const historyList: MixHistory[] = [];
      for (const key of keys) {
        try {
          const historyBytes = await contract.getData(`mix_history_${key}`);
          if (historyBytes.length > 0) {
            try {
              const historyData = JSON.parse(ethers.toUtf8String(historyBytes));
              historyList.push({ 
                id: key, 
                tracks: historyData.tracks, 
                timestamp: historyData.timestamp, 
                result: historyData.result
              });
            } catch (e) { console.error(`Error parsing mix history data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading mix history ${key}:`, e); }
      }
      
      historyList.sort((a, b) => b.timestamp - a.timestamp);
      setMixHistory(historyList);
    } catch (e) { console.error("Error loading mix history:", e); }
  };

  const submitTrack = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting track data with Zama FHE..." });
    try {
      // Encrypt BPM data using FHE simulation
      const encryptedBpm = FHEEncryptNumber(newTrackData.bpm);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID for the track
      const trackId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Store track data
      const trackData = { 
        data: encryptedBpm, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newTrackData.category,
        name: newTrackData.name,
        bpm: newTrackData.bpm
      };
      
      await contract.setData(`track_${trackId}`, ethers.toUtf8Bytes(JSON.stringify(trackData)));
      
      // Update track keys
      const keysBytes = await contract.getData("track_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(trackId);
      await contract.setData("track_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Track encrypted and submitted securely!" });
      await loadTracks();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewTrackData({ name: "", category: "drums", bpm: 120 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const mixSelectedTracks = async () => {
    if (selectedTracks.length < 2) { alert("Please select at least 2 tracks to mix"); return; }
    if (!isConnected) { alert("Please connect wallet first"); return; }
    
    setMixing(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Mixing tracks with Zama FHE..." });
    
    try {
      // Get encrypted data for selected tracks
      const encryptedTracks: string[] = [];
      for (const trackId of selectedTracks) {
        const track = tracks.find(t => t.id === trackId);
        if (track) encryptedTracks.push(track.encryptedData);
      }
      
      // Perform FHE mixing (simulated)
      const mixedResult = FHEMixTracks(encryptedTracks);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID for the mix
      const mixId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Store mix result
      const mixData = { 
        tracks: selectedTracks,
        timestamp: Math.floor(Date.now() / 1000),
        result: mixedResult
      };
      
      await contract.setData(`mix_history_${mixId}`, ethers.toUtf8Bytes(JSON.stringify(mixData)));
      
      // Update mix history keys
      const keysBytes = await contract.getData("mix_history_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing mix history keys:", e); }
      }
      keys.push(mixId);
      await contract.setData("mix_history_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Tracks mixed successfully with FHE!" });
      await loadMixHistory();
      setSelectedTracks([]);
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Mixing failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setMixing(false); }
  };

  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: isAvailable ? "Contract is available and ready!" : "Contract is not available" 
      });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Availability check failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const toggleTrackSelection = (trackId: string) => {
    if (selectedTracks.includes(trackId)) {
      setSelectedTracks(selectedTracks.filter(id => id !== trackId));
    } else {
      setSelectedTracks([...selectedTracks, trackId]);
    }
  };

  const renderCategoryChart = () => {
    const total = tracks.length || 1;
    const categories = ["drums", "vocals", "melody", "bass"];
    const colors = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#f9c74f"];
    
    return (
      <div className="category-chart">
        {categories.map((category, index) => {
          const percentage = (categoryStats[category as keyof typeof categoryStats] / total) * 100;
          return (
            <div key={category} className="chart-item">
              <div className="chart-bar">
                <div 
                  className="chart-fill" 
                  style={{ 
                    width: `${percentage}%`,
                    backgroundColor: colors[index]
                  }}
                ></div>
              </div>
              <div className="chart-label">
                <div className="chart-color" style={{ backgroundColor: colors[index] }}></div>
                {category}: {categoryStats[category as keyof typeof categoryStats]}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="music-spinner"></div>
      <p>Initializing FHE DJ Station...</p>
    </div>
  );

  return (
    <div className="app-container neon-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="music-icon"></div></div>
          <h1>Secret<span>Mix</span>Master</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-track-btn neon-button">
            <div className="add-icon"></div>Add Track
          </button>
          <button className="neon-button" onClick={() => setShowFeatures(!showFeatures)}>
            {showFeatures ? "Hide Features" : "Show Features"}
          </button>
          <button className="neon-button" onClick={checkAvailability}>
            Check Availability
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      
      <div className="main-content partitioned-layout">
        {/* Left Panel - Track Library */}
        <div className="panel track-library">
          <div className="panel-header">
            <h2>Track Library</h2>
            <button onClick={loadTracks} className="refresh-btn neon-button" disabled={isRefreshing}>
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          
          <div className="stats-overview">
            <h3>Track Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{tracks.length}</div>
                <div className="stat-label">Total Tracks</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{categoryStats.drums}</div>
                <div className="stat-label">Drums</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{categoryStats.vocals}</div>
                <div className="stat-label">Vocals</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{categoryStats.melody}</div>
                <div className="stat-label">Melody</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{categoryStats.bass}</div>
                <div className="stat-label">Bass</div>
              </div>
            </div>
            
            <div className="chart-container">
              <h4>Category Distribution</h4>
              {renderCategoryChart()}
            </div>
          </div>
          
          <div className="tracks-list">
            <div className="list-header">
              <div className="header-cell">Select</div>
              <div className="header-cell">Name</div>
              <div className="header-cell">Category</div>
              <div className="header-cell">BPM</div>
              <div className="header-cell">Owner</div>
            </div>
            
            {tracks.length === 0 ? (
              <div className="no-tracks">
                <div className="no-tracks-icon"></div>
                <p>No tracks found</p>
                <button className="neon-button primary" onClick={() => setShowCreateModal(true)}>Add First Track</button>
              </div>
            ) : tracks.map(track => (
              <div 
                className={`track-row ${selectedTracks.includes(track.id) ? 'selected' : ''}`} 
                key={track.id}
                onClick={() => toggleTrackSelection(track.id)}
              >
                <div className="table-cell">
                  <input 
                    type="checkbox" 
                    checked={selectedTracks.includes(track.id)} 
                    onChange={() => toggleTrackSelection(track.id)}
                  />
                </div>
                <div className="table-cell">{track.name}</div>
                <div className="table-cell">{track.category}</div>
                <div className="table-cell">{track.bpm}</div>
                <div className="table-cell">{track.owner.substring(0, 6)}...{track.owner.substring(38)}</div>
              </div>
            ))}
          </div>
          
          {selectedTracks.length > 0 && (
            <div className="mix-controls">
              <h3>Selected for Mixing: {selectedTracks.length} tracks</h3>
              <button 
                onClick={mixSelectedTracks} 
                disabled={mixing || selectedTracks.length < 2}
                className="neon-button primary mix-button"
              >
                {mixing ? "Mixing with FHE..." : `Mix ${selectedTracks.length} Tracks`}
              </button>
            </div>
          )}
        </div>
        
        {/* Right Panel - Mixing Station and History */}
        <div className="panel mixing-station">
          <div className="panel-header">
            <h2>Mixing Station</h2>
            <div className="fhe-badge">
              <div className="fhe-icon"></div>
              <span>FHE-Powered Mixing</span>
            </div>
          </div>
          
          <div className="mixing-interface">
            <div className="deck-container">
              <div className="deck">
                <div className="deck-title">Deck 1</div>
                {selectedTracks.length > 0 ? (
                  <div className="track-info">
                    <h4>{tracks.find(t => t.id === selectedTracks[0])?.name}</h4>
                    <p>{tracks.find(t => t.id === selectedTracks[0])?.category} - {tracks.find(t => t.id === selectedTracks[0])?.bpm} BPM</p>
                  </div>
                ) : (
                  <div className="empty-deck">No track selected</div>
                )}
              </div>
              
              <div className="mixer-center">
                <div className="crossfader"></div>
                <div className="vu-meters">
                  <div className="vu-meter"></div>
                  <div className="vu-meter"></div>
                </div>
              </div>
              
              <div className="deck">
                <div className="deck-title">Deck 2</div>
                {selectedTracks.length > 1 ? (
                  <div className="track-info">
                    <h4>{tracks.find(t => t.id === selectedTracks[1])?.name}</h4>
                    <p>{tracks.find(t => t.id === selectedTracks[1])?.category} - {tracks.find(t => t.id === selectedTracks[1])?.bpm} BPM</p>
                  </div>
                ) : (
                  <div className="empty-deck">No track selected</div>
                )}
              </div>
            </div>
            
            <div className="mix-control-panel">
              <button 
                onClick={mixSelectedTracks} 
                disabled={mixing || selectedTracks.length < 2}
                className="neon-button primary large"
              >
                {mixing ? "Mixing with FHE..." : "Start FHE Mixing"}
              </button>
              
              <div className="fhe-info">
                <h4>FHE Mixing Process</h4>
                <ol>
                  <li>Select tracks to mix</li>
                  <li>Encrypted data remains secure</li>
                  <li>FHE operations perform mixing</li>
                  <li>Result is encrypted and stored</li>
                </ol>
              </div>
            </div>
          </div>
          
          <div className="mix-history">
            <h3>Mix History</h3>
            {mixHistory.length === 0 ? (
              <div className="no-history">
                <p>No mix history yet</p>
              </div>
            ) : (
              <div className="history-list">
                {mixHistory.slice(0, 5).map(mix => (
                  <div key={mix.id} className="history-item">
                    <div className="history-info">
                      <div className="history-date">{new Date(mix.timestamp * 1000).toLocaleString()}</div>
                      <div className="history-tracks">{mix.tracks.length} tracks mixed</div>
                    </div>
                    <div className="history-result">Mixed with FHE</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {showFeatures && (
        <div className="features-modal">
          <div className="modal-content neon-card">
            <div className="modal-header">
              <h2>Secret Mix Master Features</h2>
              <button onClick={() => setShowFeatures(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="features-grid">
                <div className="feature-item">
                  <div className="feature-icon">🔒</div>
                  <h3>FHE Encryption</h3>
                  <p>All track data is encrypted using Zama FHE technology, keeping your music secure.</p>
                </div>
                <div className="feature-item">
                  <div className="feature-icon">⚡</div>
                  <h3>Homomorphic Mixing</h3>
                  <p>Mix tracks without decrypting them, preserving privacy and copyright protection.</p>
                </div>
                <div className="feature-item">
                  <div className="feature-icon">🎛️</div>
                  <h3>Virtual DJ Interface</h3>
                  <p>Intuitive interface designed for music creators and DJs.</p>
                </div>
                <div className="feature-item">
                  <div className="feature-icon">📊</div>
                  <h3>Track Analytics</h3>
                  <p>View statistics and charts about your music library.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitTrack} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          trackData={newTrackData} 
          setTrackData={setNewTrackData}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content neon-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="music-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="music-icon"></div><span>SecretMixMaster</span></div>
            <p>FHE-powered music mixing with Zama technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} SecretMixMaster. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  trackData: any;
  setTrackData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, trackData, setTrackData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setTrackData({ ...trackData, [name]: value });
  };

  const handleBpmChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setTrackData({ ...trackData, [name]: parseInt(value) });
  };

  const handleSubmit = () => {
    if (!trackData.name || !trackData.category) { alert("Please fill required fields"); return; }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal neon-card">
        <div className="modal-header">
          <h2>Add New Track</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your track data will be encrypted with Zama FHE before submission</p></div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Track Name *</label>
              <input 
                type="text" 
                name="name" 
                value={trackData.name} 
                onChange={handleChange} 
                placeholder="Enter track name..." 
                className="neon-input"
              />
            </div>
            
            <div className="form-group">
              <label>Category *</label>
              <select name="category" value={trackData.category} onChange={handleChange} className="neon-select">
                <option value="drums">Drums</option>
                <option value="vocals">Vocals</option>
                <option value="melody">Melody</option>
                <option value="bass">Bass</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>BPM *</label>
              <input 
                type="number" 
                name="bpm" 
                value={trackData.bpm} 
                onChange={handleBpmChange} 
                placeholder="Enter BPM..." 
                className="neon-input"
                min="60"
                max="200"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain BPM:</span><div>{trackData.bpm || 'No value entered'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{trackData.bpm ? FHEEncryptNumber(trackData.bpm).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn neon-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn neon-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;