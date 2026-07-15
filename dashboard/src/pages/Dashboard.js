import { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

const FLASK  = 'http://localhost:5000';
const PLACES = [
  'SJCE Campus Mysuru','Aishwarya Petrol Bunk Mysuru','Mysore Palace',
  'Hotel RRR Mysuru','JSS Hospital Mysuru',
  'Aroma The Bakers','Mysuru Railway Station'
];

function FitMap({ route }) {
  const map = useMap();
  useEffect(() => {
    if (route.length > 1) map.fitBounds(route, { padding:[30,30] });
  }, [route]);
  return null;
}

const STEPS = ['Route Planned','Robot Dispatched','En Route','Near Destination','Delivered'];
const ACTION_COLOR = a =>
  a?.includes('LANE')   ? '#f59e0b' :
  a?.includes('WAIT')   ? '#ef4444' :
  a?.includes('REROUTE')? '#8b5cf6' :
  a?.includes('SLOW')   ? '#f97316' : '#10b981';

export default function Dashboard() {
  const moveRef = useRef(null);

  const [route,       setRoute]       = useState([]);
  const [robotPos,    setRobotPos]    = useState(null);
  const [routeIdx,    setRouteIdx]    = useState(0);
  const [cameraFrame, setCameraFrame] = useState('');
  const [aiDecision,  setAiDecision]  = useState({
    decision: 'IDLE',
    reason:   'System ready. Select source and destination to begin.',
    label:    ''
  });
  const [logs,        setLogs]        = useState([]);
  const [robotStatus, setRobotStatus] = useState({ battery:100, speed:0, action:'Idle', lane:'centre' });
  const [delivery,    setDelivery]    = useState({ status:'idle', order_id:'', source:'', destination:'', distance_km:0, eta_minutes:0 });
  const [step,        setStep]        = useState(0);

  const [source,      setSource]      = useState('SJCE Campus Mysuru');
  const [dest,        setDest]        = useState('Aishwarya Petrol Bunk Mysuru');
  
  const [delivering,  setDelivering]  = useState(false);
  const [trafficInfo, setTrafficInfo] = useState({ road:'—', status:'Clear', alt:'Available', saved:0 });

  // ── SSE — real-time events from Flask ──────────────────
  useEffect(() => {
    const es = new EventSource(`${FLASK}/stream`);
    es.onmessage = e => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'frame') {
          setCameraFrame(ev.data.image || '');
          setRobotStatus(s => ({
            ...s,
            action: ev.data.action || s.action,
            lane:   ev.data.lane   || s.lane,
            speed:  ev.data.speed  !== undefined ? ev.data.speed : s.speed,
          }));
        }
        if (ev.type === 'battery')
          setRobotStatus(s => ({ ...s, battery: ev.data.level }));
        if (ev.type === 'position') {
          setRobotPos([ev.data.lat, ev.data.lng]);
          setRouteIdx(ev.data.index || 0);
          setDelivery(d => ({ ...d, eta_minutes: ev.data.eta || d.eta_minutes }));
        }
        if (ev.type === 'obstacle') {
          setLogs(l => [ev.data, ...l].slice(0, 15));
          setAiDecision({ decision: ev.data.decision, reason: ev.data.reason, label: ev.data.event });
        }
        if (ev.type === 'ai_decision')
          setAiDecision(ev.data);
        if (ev.type === 'robot_update')
          setRobotStatus(s => ({ ...s, action: ev.data.action || s.action }));
        if (ev.type === 'route') {
          setRoute(ev.data.route || []);
          setDelivery(d => ({ ...d, ...ev.data }));
          setStep(1);
        }
        if (ev.type === 'status' && ev.data.delivery_status === 'delivered') {
          setStep(4);
          setDelivering(false);
          setRobotStatus(s => ({ ...s, speed: 0, action: 'Delivery Complete' }));
          setAiDecision({ decision: 'DELIVERED ✅', reason: 'Package delivered successfully. Robot returning to base.', label: '' });
        }
      } catch {}
    };
    return () => es.close();
  }, []);

  // ── Start delivery ──────────────────────────────────────
  async function startDelivery() {
    if (source === dest || delivering) return;
    setDelivering(true);
    setStep(0);
    setLogs([]);
    setCameraFrame('');
    setRobotPos(null);
    setAiDecision({ decision: 'PLANNING ROUTE', reason: 'Calculating shortest path using Dijkstra on Mysuru road network...', label: '' });

    try {
      const res  = await fetch(`${FLASK}/start_delivery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ source, destination: dest })
      });
      const data = await res.json();
      if (!data.ok) { setDelivering(false); return; }

      const r = data.waypoints || [];
      setRoute(r);
      setStep(1);
      setDelivery({
        status:       'in_transit',
        order_id:     data.order_id  || '',
        source,
        destination:  dest,
        distance_km:  data.distance_km  || 0,
        eta_minutes:  data.eta_minutes  || 0,
      });
      setAiDecision({ decision: 'MOVING', reason: `Route calculated: ${r.length} waypoints, ${data.distance_km} km. Robot dispatched.`, label: '' });
      setTrafficInfo({ road: source.split(',')[0], status: 'Clear', alt: 'Available', saved: 0 });

      // Animate robot on map
      let idx = 0;
      if (moveRef.current) clearInterval(moveRef.current);
      moveRef.current = setInterval(() => {
        if (idx >= r.length) {
          clearInterval(moveRef.current);
          setStep(4);
          setDelivering(false);
          return;
        }
        setRobotPos(r[idx]);
        setRouteIdx(idx);
        // Simulate traffic midway
        if (idx === Math.floor(r.length * 0.4)) {
          setStep(2);
          setTrafficInfo({ road: source.split(',')[0], status: 'Moderate', alt: 'Available', saved: Math.floor(Math.random()*4)+2 });
        }
        if (idx === Math.floor(r.length * 0.75)) setStep(3);
        idx++;
      }, 600);

    } catch {
      setDelivering(false);
      setAiDecision({ decision: 'ERROR', reason: 'Cannot connect to Flask server. Make sure app.py is running.', label: '' });
    }
  }

  // ── Map icons ────────────────────────────────────────────
  const robotIcon = L.divIcon({
    className: '',
    html: `<div style="width:24px;height:24px;background:#10b981;border:2px solid #fff;border-radius:50%;box-shadow:0 0 12px #10b98199;display:flex;align-items:center;justify-content:center;font-size:12px">🤖</div>`,
    iconSize:[24,24], iconAnchor:[12,12]
  });
  const srcIcon = L.divIcon({
    className:'',
    html:`<div style="background:#2563eb;color:#fff;padding:4px 8px;border-radius:12px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.2)">A</div>`,
    iconSize:[20,20]
  });
  const dstIcon = L.divIcon({
    className:'',
    html:`<div style="background:#ef4444;color:#fff;padding:4px 8px;border-radius:12px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.2)">B</div>`,
    iconSize:[20,20]
  });

  const batColor = robotStatus.battery > 60 ? '#10b981' : robotStatus.battery > 25 ? '#f59e0b' : '#ef4444';

  return (
    <div style={S.page}>

      {/* ══ SIDEBAR */}
      <aside style={S.sidebar}>

        {/* Brand */}
        <div style={S.brandBox}>
          <div style={{fontSize:36,marginBottom:6}}>🤖</div>
          <div style={S.brandTitle}>Multi-Modal Sensor Fusion</div>
          <div style={S.brandSub}>AI-Based Navigation for Delivery Robots</div>
          <div style={{display:'flex',alignItems:'center',gap:6,marginTop:10,justifyContent:'center'}}>
            <div style={{width:8,height:8,borderRadius:'50%',background: delivering?'#10b981':'#94a3b8',boxShadow: delivering?'0 0 6px #10b981':''}}/>
            <span style={{fontSize:12,color: delivering?'#10b981':'#94a3b8',fontWeight:600}}>
              {delivering ? 'Robot Active' : 'System Ready'}
            </span>
          </div>
        </div>

        {/* Active delivery info */}
        <div style={{flex:1,padding:'14px',overflowY:'auto'}}>
          {delivery.order_id ? (
            <div style={S.orderCard}>
              <div style={S.orderLabel}>ACTIVE DELIVERY</div>
              <div style={{fontSize:12,color:'#2563eb',fontWeight:700,marginBottom:12}}>
                SESSION #{delivery.order_id}
              </div>

              <div style={S.routeRow}>
                <div style={{...S.routeDot, background:'#10b981'}}/>
                <div>
                  <div style={{fontSize:10,color:'#94a3b8'}}>SOURCE</div>
                  <div style={{fontSize:12,fontWeight:600,color:'#1e293b'}}>{(delivery.source||'').replace(', Mysuru','')}</div>
                </div>
              </div>
              <div style={{width:2,height:16,background:'#e2e8f0',marginLeft:5,margin:'3px 0 3px 5px'}}/>
              <div style={S.routeRow}>
                <div style={{...S.routeDot, background:'#ef4444'}}/>
                <div>
                  <div style={{fontSize:10,color:'#94a3b8'}}>DESTINATION</div>
                  <div style={{fontSize:12,fontWeight:600,color:'#1e293b'}}>{(delivery.destination||'').replace(', Mysuru','')}</div>
                </div>
              </div>

              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:14}}>
                <div style={S.chip}>
                  <div style={{fontSize:18,fontWeight:800,color:'#2563eb'}}>{delivery.eta_minutes}</div>
                  <div style={{fontSize:10,color:'#94a3b8'}}>mins ETA</div>
                </div>
                <div style={S.chip}>
                  <div style={{fontSize:18,fontWeight:800,color:'#374151'}}>{delivery.distance_km}</div>
                  <div style={{fontSize:10,color:'#94a3b8'}}>km total</div>
                </div>
              </div>

              <div style={{marginTop:12}}>
                <div style={{fontSize:10,color:'#94a3b8',marginBottom:4}}>PROGRESS</div>
                <div style={{height:4,background:'#e2e8f0',borderRadius:2}}>
                  <div style={{width:`${route.length > 0 ? (routeIdx/route.length)*100 : 0}%`, height:'100%', background:'#2563eb', borderRadius:2, transition:'width .5s'}}/>
                </div>
                <div style={{fontSize:10,color:'#64748b',marginTop:3}}>{routeIdx} / {route.length} waypoints</div>
              </div>
            </div>
          ) : (
            <div style={{textAlign:'center',padding:'24px 12px',color:'#94a3b8'}}>
              <div style={{fontSize:40,marginBottom:12}}>📍</div>
              <div style={{fontSize:12,lineHeight:1.6}}>Delivery Info</div>
            </div>
          )}
        </div>

      </aside>

      {/* ══ MAIN CONTENT ══════════════════════════════════ */}
      <main style={S.main}>

        {/* Delivery form */}
        <div style={S.formRow}>
          <div style={{fontSize:12,fontWeight:600,color:'#64748b',whiteSpace:'nowrap'}}>SOURCE</div>
          <select style={S.sel} value={source} onChange={e => setSource(e.target.value)}>
            {PLACES.map(p => <option key={p}>{p}</option>)}
          </select>
          <div style={{color:'#94a3b8',fontWeight:700,fontSize:16}}>→</div>
          <div style={{fontSize:12,fontWeight:600,color:'#64748b',whiteSpace:'nowrap'}}>DESTINATION</div>
          <select style={S.sel} value={dest} onChange={e => setDest(e.target.value)}>
            {PLACES.map(p => <option key={p}>{p}</option>)}
          </select>
          <button onClick={startDelivery} disabled={delivering || source === dest}
            style={{...S.startBtn, opacity: (delivering||source===dest) ? 0.6 : 1}}>
            {delivering ? '● In Progress' : '▶ Start Simulation'}
          </button>
        </div>

        {/* Map + Camera */}
        <div style={S.row2}>

          {/* MAP */}
          <div style={S.card}>
            <div style={S.cardHead}>
              <span style={S.cardTitle}>📍 LIVE MAP ROUTE — Mysuru Road Network</span>
              <div style={{display:'flex',gap:14,fontSize:11,color:'#64748b'}}>
                <span><b style={{color:'#2563eb'}}>━━</b> Planned Route</span>
                <span><b style={{color:'#ef4444'}}>A→B</b> Source/Dest</span>
              </div>
            </div>
            <div style={{flex:1}}>
              <MapContainer center={[12.2958,76.6394]} zoom={13}
                style={{height:'100%',minHeight:270}} zoomControl={false}>
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; OpenStreetMap'/>
                {route.length > 1 &&
                  <Polyline positions={route} pathOptions={{color:'#2563eb',weight:4,opacity:.85}}/>}
                {route.length > 0 &&
                  <Marker position={route[0]} icon={srcIcon}><Popup>Source: {source}</Popup></Marker>}
                {route.length > 1 &&
                  <Marker position={route[route.length-1]} icon={dstIcon}><Popup>Destination: {dest}</Popup></Marker>}
                {robotPos &&
                  <Marker position={robotPos} icon={robotIcon}><Popup>🤖 Robot — {robotStatus.action}</Popup></Marker>}
                {route.length > 1 && <FitMap route={route}/>}
              </MapContainer>
            </div>
            {/* Progress steps */}
            <div style={S.steps}>
              {STEPS.map((s,i) => (
                <div key={s} style={{display:'flex',flexDirection:'column',alignItems:'center',flex:1}}>
                  <div style={{...S.stepDot,
                    background: i < step?'#2563eb': i===step?'#93c5fd':'#e2e8f0',
                    color:      i <= step?'#fff':'#94a3b8',
                    boxShadow:  i===step?'0 0 0 3px #bfdbfe':''
                  }}>
                    {i < step ? '✓' : i+1}
                  </div>
                  <div style={{fontSize:9,color:i<=step?'#2563eb':'#94a3b8',textAlign:'center',marginTop:4,fontWeight:i===step?700:400,maxWidth:70}}>{s}</div>
                </div>
              ))}
            </div>
          </div>

          {/* CAMERA */}
          <div style={S.card}>
            <div style={S.cardHead}>
              <span style={S.cardTitle}>📷 ROBOT CAMERA VIEW — Live Detection</span>
              <span style={{fontSize:11,fontWeight:700,color: robotStatus.speed>0?'#10b981':'#94a3b8'}}>
                {robotStatus.speed>0 ? `● ${robotStatus.speed} km/h` : '● Stopped'}
              </span>
            </div>
            <div style={S.camBox}>
              {cameraFrame
                ? <img src={`data:image/jpeg;base64,${cameraFrame}`}
                    style={{width:'100%',height:'100%',objectFit:'cover'}} alt="camera feed"/>
                : <div style={S.camPlaceholder}>
                    <span style={{fontSize:40}}>📷</span>
                    <span style={{color:'#94a3b8',fontSize:13,marginTop:10,textAlign:'center'}}>
                      Waiting for camera feed...
                    </span>
                  </div>
              }
            </div>
          </div>
        </div>

        {/* AI Decision + Logs */}
        <div style={S.row3}>

          {/* AI DECISION */}
          <div style={S.card}>
            <div style={S.cardHead}><span style={S.cardTitle}>🧠 AI DECISION &amp; EXPLANATION</span></div>
            <div style={{flex:1,padding:'16px',display:'flex',gap:16,alignItems:'flex-start'}}>
              <div style={{flex:1}}>
                <div style={{fontSize:19,fontWeight:800,color:ACTION_COLOR(aiDecision.decision),marginBottom:8,lineHeight:1.3}}>
                  {aiDecision.decision || 'IDLE'}
                </div>
                {aiDecision.label && (
                  <div style={{fontSize:12,color:'#64748b',marginBottom:8}}>
                    Detected: <b style={{color:'#374151',background:'#f1f5f9',padding:'2px 7px',borderRadius:4}}>{aiDecision.label}</b>
                  </div>
                )}
                <div style={{fontSize:12,color:'#374151',lineHeight:1.8,background:'#f8fafc',padding:'10px 12px',borderRadius:8,border:'1px solid #e2e8f0'}}>
                  <b>Reason:</b><br/>{aiDecision.reason || 'System ready.'}
                </div>
              </div>
              <div style={{fontSize:44,minWidth:50,textAlign:'center'}}>
                {aiDecision.decision?.includes('WAIT')     ? '⏸️' :
                 aiDecision.decision?.includes('LANE')     ? '↰'  :
                 aiDecision.decision?.includes('REROUTE')  ? '🔄' :
                 aiDecision.decision?.includes('SLOW')     ? '⚠️' :
                 aiDecision.decision?.includes('DELIV')    ? '✅' :
                 aiDecision.decision?.includes('PLAN')     ? '🗺️' : '▶️'}
              </div>
            </div>
          </div>

          {/* AI LOGS */}
          <div style={{...S.card,maxHeight:220}}>
            <div style={S.cardHead}><span style={S.cardTitle}>📋 AI DETECTION LOGS</span></div>
            <div style={{overflowY:'auto',flex:1}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead>
                  <tr style={{background:'#f8fafc',position:'sticky',top:0}}>
                    {['Time','Detected','Decision','Reason'].map(h=>(
                      <th key={h} style={{padding:'7px 10px',textAlign:'left',fontWeight:600,
                        color:'#64748b',borderBottom:'1px solid #e2e8f0',fontSize:11,whiteSpace:'nowrap'}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0
                    ? <tr><td colSpan={4} style={{padding:'20px',color:'#94a3b8',fontStyle:'italic',textAlign:'center'}}>
                        No detection events yet
                      </td></tr>
                    : logs.map((log,i) => (
                        <tr key={i} style={{borderBottom:'1px solid #f1f5f9',background:i===0?'#fffbeb':'transparent'}}>
                          <td style={{padding:'7px 10px',color:'#94a3b8',whiteSpace:'nowrap'}}>{log.time}</td>
                          <td style={{padding:'7px 10px',fontWeight:600,color:'#374151'}}>{log.event}</td>
                          <td style={{padding:'7px 10px',whiteSpace:'nowrap'}}>
                            <span style={{background:ACTION_COLOR(log.decision)+'22',color:ACTION_COLOR(log.decision),
                              padding:'2px 8px',borderRadius:10,fontWeight:700,fontSize:11}}>
                              {log.decision}
                            </span>
                          </td>
                          <td style={{padding:'7px 10px',color:'#64748b',fontSize:11}}>{log.reason}</td>
                        </tr>
                      ))
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>

      {/* ══ RIGHT PANEL ══════════════════════════════════ */}
      <aside style={S.right}>

        {/* Robot Status */}
        <div style={{borderBottom:'1px solid #e2e8f0'}}>
          <div style={S.cardHead}><span style={S.cardTitle}>🤖 ROBOT STATUS</span></div>
          <div style={{padding:'14px 16px'}}>
            <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16,background:'#f8fafc',padding:'10px 12px',borderRadius:10,border:'1px solid #e2e8f0'}}>
              <span style={{fontSize:32}}>🤖</span>
              <div>
                <div style={{fontSize:11,color:'#64748b'}}>Robot ID</div>
                <div style={{fontSize:15,fontWeight:800,color:'#2563eb'}}>RB-101</div>
                <div style={{fontSize:11,fontWeight:600,color: delivering?'#10b981':'#94a3b8'}}>
                  ● {delivering ? 'Active' : 'Idle'}
                </div>
              </div>
            </div>

            {[
              { icon:'🔋', label:'Battery', value:`${robotStatus.battery}%`,
                bar:robotStatus.battery, barColor:batColor, max:100 },
              { icon:'⚡', label:'Speed', value:`${robotStatus.speed} km/h`,
                bar:robotStatus.speed, barColor: robotStatus.speed===0?'#ef4444':robotStatus.speed<15?'#f59e0b':'#2563eb', max:30 },
            ].map(item => (
              <div key={item.label} style={{marginBottom:14}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                  <span style={{fontSize:12,color:'#64748b'}}>{item.icon} {item.label}</span>
                  <span style={{fontWeight:700,fontSize:12,color:item.barColor}}>{item.value}</span>
                </div>
                <div style={{height:6,background:'#e2e8f0',borderRadius:3}}>
                  <div style={{width:`${Math.min((item.bar/item.max)*100,100)}%`,height:'100%',
                    background:item.barColor,borderRadius:3,transition:'all .5s ease'}}/>
                </div>
              </div>
            ))}

            {[
              { icon:'🎯', label:'Action', value: robotStatus.action||'Idle', color: ACTION_COLOR(robotStatus.action) },
              { icon:'🛣️', label:'Lane',   value: robotStatus.lane||'centre',  color:'#374151' },
              { icon:'📍', label:'Waypoint',value:`${routeIdx} / ${route.length||0}`, color:'#374151' },
            ].map(item => (
              <div key={item.label} style={{display:'flex',justifyContent:'space-between',
                alignItems:'center',padding:'7px 0',borderBottom:'1px solid #f1f5f9'}}>
                <span style={{fontSize:12,color:'#64748b'}}>{item.icon} {item.label}</span>
                <span style={{fontSize:12,fontWeight:700,color:item.color,textTransform:'capitalize',
                  textAlign:'right',maxWidth:100}}>{item.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Route & Traffic */}
        <div style={{flex:1}}>
          <div style={S.cardHead}><span style={S.cardTitle}>🗺️ ROUTE &amp; TRAFFIC INFO</span></div>
          <div style={{padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
            {[
              { icon:'🛣️', label:'Current Road',      value: trafficInfo.road || '—' },
              { icon:'🚦', label:'Traffic Status',    value: trafficInfo.status,
                color: trafficInfo.status==='Clear'?'#10b981':trafficInfo.status==='Moderate'?'#f59e0b':'#ef4444' },
              { icon:'🔄', label:'Alternative Route', value: trafficInfo.alt, color:'#10b981' },
              { icon:'⏱️', label:'Time Saved',        value: `${trafficInfo.saved} mins`, color:'#2563eb' },
            ].map(item => (
              <div key={item.label} style={{display:'flex',alignItems:'center',gap:12,
                padding:'8px 0',borderBottom:'1px solid #f1f5f9'}}>
                <span style={{fontSize:22}}>{item.icon}</span>
                <div>
                  <div style={{fontSize:10,color:'#94a3b8',marginBottom:2}}>{item.label}</div>
                  <div style={{fontSize:13,fontWeight:700,color:item.color||'#374151'}}>{item.value}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

      </aside>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────
const S = {
  page:        {display:'grid',gridTemplateColumns:'220px 1fr 210px',height:'100vh',background:'#f1f5f9',fontFamily:'"Inter",-apple-system,sans-serif',overflow:'hidden'},
  sidebar:     {background:'#fff',borderRight:'1px solid #e2e8f0',display:'flex',flexDirection:'column',overflowY:'auto'},
  brandBox:    {padding:'20px 16px 16px',borderBottom:'1px solid #e2e8f0',textAlign:'center'},
  brandTitle:  {fontSize:13,fontWeight:800,color:'#1e293b',marginBottom:3,lineHeight:1.3},
  brandSub:    {fontSize:10,color:'#94a3b8',lineHeight:1.4},
  orderCard:   {background:'#f8fafc',borderRadius:10,padding:14,border:'1px solid #e2e8f0'},
  orderLabel:  {fontSize:10,fontWeight:700,color:'#94a3b8',letterSpacing:'.08em',marginBottom:6},
  routeRow:    {display:'flex',alignItems:'flex-start',gap:8},
  routeDot:    {width:8,height:8,borderRadius:'50%',marginTop:4,flexShrink:0},
  chip:        {background:'#fff',border:'1px solid #e2e8f0',borderRadius:8,padding:'8px 10px',textAlign:'center'},
  main:        {display:'flex',flexDirection:'column',gap:10,padding:12,overflowY:'auto'},
  formRow:     {background:'#fff',borderRadius:10,padding:'10px 14px',display:'flex',gap:8,alignItems:'center',border:'1px solid #e2e8f0',flexWrap:'wrap'},
  sel:         {flex:1,minWidth:150,padding:'8px 10px',border:'1.5px solid #e2e8f0',borderRadius:7,fontSize:12,outline:'none',background:'#f8fafc',color:'#1e293b'},
  startBtn:    {padding:'9px 18px',background:'#2563eb',color:'#fff',border:'none',borderRadius:8,fontWeight:700,fontSize:13,cursor:'pointer',whiteSpace:'nowrap'},
  row2:        {display:'grid',gridTemplateColumns:'1fr 1fr',gap:10},
  row3:        {display:'grid',gridTemplateColumns:'1fr 1.8fr',gap:10},
  card:        {background:'#fff',borderRadius:12,border:'1px solid #e2e8f0',display:'flex',flexDirection:'column',overflow:'hidden'},
  cardHead:    {padding:'10px 14px',borderBottom:'1px solid #f1f5f9',display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0},
  cardTitle:   {fontSize:11,fontWeight:700,color:'#64748b',letterSpacing:'.04em'},
  camBox:      {flex:1,background:'#0f172a',display:'flex',alignItems:'center',justifyContent:'center',minHeight:230,overflow:'hidden'},
  camPlaceholder:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:24,color:'#fff'},
  steps:       {display:'flex',justifyContent:'space-between',padding:'10px 14px',borderTop:'1px solid #f1f5f9',flexShrink:0},
  stepDot:     {width:24,height:24,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:700,transition:'all .4s'},
  right:       {background:'#fff',borderLeft:'1px solid #e2e8f0',display:'flex',flexDirection:'column',overflowY:'auto'},
};