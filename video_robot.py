import cv2, numpy as np, time, json, urllib.request, base64, os, csv
from ultralytics import YOLO

# CONFIG 
ROUTES = {
    "sjce campus mysuru|||aishwarya petrol bunk mysuru": {
        "video":     "D:/Delivery_Robot_Project/dataset/sjce_aishwarya.mp4",
        "gps":       "D:/Delivery_Robot_Project/dataset/sjce_aishwarya_gps.csv",
        "alt_video": "D:/Delivery_Robot_Project/dataset/sjce_aishwarya_alt_cut.mp4",  
        "alt_gps":   "D:/Delivery_Robot_Project/dataset/sjce_aishwarya_alt_gps.csv",  
    }
}
DEFAULT_VIDEO = "D:/Delivery_Robot_Project/dataset/mys.mp4"
MODEL_PATH  = "D:/Delivery_Robot_Project/models/best.pt"
FLASK_URL   = "http://localhost:5000"
FRAME_SKIP  = 60
FRAME_DELAY = 0.5
MIN_GPS_BEFORE_REROUTE = 70

OBSTACLE_CLASSES = {
    "animal":       ("WAIT",        "Animal on road. Waiting for safe movement."),
    "person":       ("WAIT",        "Pedestrian detected.Checking gap. If crossing, waiting to cross."),
    "car":          ("LANE CHANGE", "Vehicle blocking. Checking adjacent lane."),
    "autorickshaw": ("LANE CHANGE", "Auto-rickshaw ahead. Switching lane."),
    "motorcycle":   ("LANE CHANGE", "Motorcycle in path. Checking gap."),
    "bicycle":      ("LANE CHANGE", "Cyclist ahead. Checking gap."),
    "truck":        ("LANE CHANGE", "Large vehicle ahead. Checking adjacent lane for gap."),
    "bus":          ("LANE CHANGE", "Bus ahead. Checking adjacent lane for gap."),
    "rider":        ("SLOW DOWN",   "Rider detected. Slowing down."),
}

ACTION_SPEED = {
    "MOVING":            24,
    "LANE CHANGE LEFT":  15,
    "LANE CHANGE RIGHT": 15,
    "SLOW DOWN":          8,
    "WAIT":               0,
    "REROUTING":          0,
}

def get_speed(action):
    for key, spd in ACTION_SPEED.items():
        if key in action.upper():
            return spd
    return 24

def load_gps_track(csv_path):
    track = []
    if not os.path.exists(csv_path):
        print(f"⚠ GPS file not found: {csv_path}")
        return track
    with open(csv_path, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                lat = float(row['latitude'])
                lng = float(row['longitude'])
                if lat != 0 and lng != 0:
                    track.append((lat, lng))
            except (ValueError, KeyError):
                continue
    print(f"✅ GPS loaded: {len(track)} points from {os.path.basename(csv_path)}")
    if track:
        print(f"   Start: {track[0]}")
        print(f"   End  : {track[-1]}")
    return track

def gps_to_route_format(track):
    return [[lat, lng] for lat, lng in track]

model = YOLO(MODEL_PATH)
print("✅ Model loaded")

def post(endpoint, data):
    try:
        payload = json.dumps(data).encode()
        req = urllib.request.Request(
            f"{FLASK_URL}/{endpoint}", data=payload,
            headers={"Content-Type":"application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=0.2)
    except:
        pass

def detect_lanes(frame):
    h, w  = frame.shape[:2]
    roi   = frame[int(h*0.6):, :]
    gray  = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    blur  = cv2.GaussianBlur(gray, (9,9), 0)
    edges = cv2.Canny(blur, 60, 180)
    lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=80,
                             minLineLength=80, maxLineGap=20)
    left_pts, right_pts = [], []
    if lines is not None:
        for x1,y1,x2,y2 in lines[:,0]:
            if x2 == x1: continue
            slope = (y2-y1)/(x2-x1)
            length = np.sqrt((x2-x1)**2+(y2-y1)**2)
            if -1.5 < slope < -0.4 and length > 60:
                left_pts.append((x1,y1,x2,y2))
            elif 0.4 < slope < 1.5 and length > 60:
                right_pts.append((x1,y1,x2,y2))
    best_left  = max(left_pts,  key=lambda l: np.sqrt((l[2]-l[0])**2+(l[3]-l[1])**2)) if left_pts  else None
    best_right = max(right_pts, key=lambda l: np.sqrt((l[2]-l[0])**2+(l[3]-l[1])**2)) if right_pts else None
    result_l = [(best_left[0],  best_left[1]+int(h*0.6),  best_left[2],  best_left[3]+int(h*0.6))]  if best_left  else []
    result_r = [(best_right[0], best_right[1]+int(h*0.6), best_right[2], best_right[3]+int(h*0.6))] if best_right else []
    return result_l, result_r

def draw_lane_lines(frame, left, right):
    for x1,y1,x2,y2 in left:
        cv2.line(frame, (x1,y1), (x2,y2), (0,220,220), 3)
    for x1,y1,x2,y2 in right:
        cv2.line(frame, (x1,y1), (x2,y2), (0,220,220), 3)

def draw_robot(frame, offset_x, action):
    h, w = frame.shape[:2]
    cx = w//2 + offset_x; cy = h - 55
    cv2.rectangle(frame, (cx-20,cy-28),(cx+20,cy+12),(0,210,150),-1)
    cv2.rectangle(frame, (cx-20,cy-28),(cx+20,cy+12),(255,255,255),2)
    cv2.circle(frame, (cx-13,cy+12), 8, (50,50,50), -1)
    cv2.circle(frame, (cx+13,cy+12), 8, (50,50,50), -1)
    cv2.circle(frame, (cx,cy-10), 9, (0,180,255), -1)
    cv2.circle(frame, (cx,cy-10), 4, (0,0,0), -1)
    color = (0,180,60) if "MOVING" in action else (0,60,200) if "WAIT" in action else (0,120,255) if "LANE" in action else (150,0,200)
    cv2.putText(frame, action, (cx-55,cy-38), cv2.FONT_HERSHEY_SIMPLEX, 0.42, color, 1, cv2.LINE_AA)

def check_gap(boxes, side, lx, rx, fw):
    lw = rx - lx
    zone = (max(0,lx-lw), lx) if side=="left" else (rx, min(fw,rx+lw))
    for box in boxes:
        cx = float((box.xyxy[0][0]+box.xyxy[0][2])/2)
        if zone[0] < cx < zone[1] and float(box.xyxy[0][3]) > 200:
            return False
    return True

# ── Wait for delivery 
print("Waiting for delivery to start...")
src_name = dest_name = ""
while True:
    try:
        res  = urllib.request.urlopen(f"{FLASK_URL}/status", timeout=2)
        data = json.loads(res.read())
        if data.get("delivery_status") == "in_transit":
            src_name  = data.get("source","").lower()
            dest_name = data.get("destination","").lower()
            print(f"✅ Delivery: {src_name} → {dest_name}")
            break
    except:
        pass
    time.sleep(1)

# Load route config 
route_key    = f"{src_name}|||{dest_name}"
route_config = ROUTES.get(route_key)

if route_config is None:
    print(f"⚠ No GPS config for route: {route_key}")
    print(f"  Using default video: {DEFAULT_VIDEO}")   
    video_path = DEFAULT_VIDEO                          
    gps_track  = []
    alt_video  = None
    alt_gps    = []
else:
    video_path = route_config["video"]
    gps_track  = load_gps_track(route_config["gps"])
    alt_video  = route_config.get("alt_video")
    alt_gps    = load_gps_track(route_config.get("alt_gps",""))

if gps_track:
    gps_route = gps_to_route_format(gps_track)
    post("update_route", {"route": gps_route})
    print(f"✅ GPS route sent to map: {len(gps_route)} points")

def open_video(path):
    if path and os.path.exists(path):
        cap   = cv2.VideoCapture(path)
        fps   = cap.get(cv2.CAP_PROP_FPS) or 30
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        print(f"✅ Video: {os.path.basename(path)} ({total} frames @ {fps:.0f}fps)")
        print(f"   With FRAME_SKIP={FRAME_SKIP}: will process {total//FRAME_SKIP} frames")
        print(f"   Demo duration: ~{(total//FRAME_SKIP)*FRAME_DELAY:.0f} seconds")
        return cap, fps, total
    return None, 30, 0

def _do_reroute(label, conf, reason):
    global cap, video_fps, gps_track, gps_index, frame_num, rerouted, last_post
    if rerouted or not alt_video or not alt_gps:
        return
    if gps_index < MIN_GPS_BEFORE_REROUTE:              
        return                                           
    print(f"🔄 REROUTING at GPS {gps_index} — {reason}")
    if cap: cap.release()
    cap, video_fps, _ = open_video(alt_video)
    gps_track  = alt_gps
    gps_index  = 0
    frame_num  = 0
    rerouted   = True
    post("update_route", {"route":gps_to_route_format(alt_gps),"is_reroute":True})
    post("obstacle", {"label":label,"confidence":round(conf,2),
                       "decision":"REROUTE","reason":reason,
                       "time":time.strftime("%H:%M:%S")})
    last_post = time.time()

cap, video_fps, total_frames = open_video(video_path)

use_imgs = False

gps_index   = 0
current_gps = gps_track[0] if gps_track else None

frame_num      = 0
lane_offset    = 0
lane_hold      = 0
current_action = "MOVING"
current_lane   = "centre"
wait_start     = None
battery        = 100.0
last_post      = 0
rerouted       = False

print(f"▶ Robot streaming — 1 frame every {FRAME_DELAY}s...")

while True:
    target_frame = frame_num + FRAME_SKIP
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    ret, frame = cap.read()
    if not ret:
        break
    frame_num = target_frame
    h, w = frame.shape[:2]

    # GPS position
    new_gps_idx = min(frame_num // FRAME_SKIP, len(gps_track)-1)
    if gps_track and new_gps_idx != gps_index:
        gps_index = new_gps_idx
        lat, lng  = gps_track[gps_index]
        remaining_pts = len(gps_track) - gps_index
        eta_mins      = max(0, int(remaining_pts * FRAME_DELAY / 60))
        post("position", {"lat":lat,"lng":lng,"index":gps_index,"eta":eta_mins})
        print(f"GPS {gps_index}/{len(gps_track)}: ({lat:.6f}, {lng:.6f})")
        
    if gps_track and gps_index == MIN_GPS_BEFORE_REROUTE and not rerouted:
        post("obstacle", {
            "label":      "traffic_signal",
            "confidence": 0.93,
            "decision":   "REROUTE",
            "reason":     "Heavy traffic signal ahead. Road congested. Switching to alternate route.",
            "time":       time.strftime("%H:%M:%S")
        })

    # Battery
    if frame_num % (FRAME_SKIP * 10) == 0 and frame_num > 0:
        battery = max(0, battery - 1.0)
        post("battery", {"level": round(battery, 1)})

    # Lane detection
    left_l, right_l = detect_lanes(frame)
    for x1,y1,x2,y2 in left_l:  cv2.line(frame,(x1,y1),(x2,y2),(0,230,230),2)
    for x1,y1,x2,y2 in right_l: cv2.line(frame,(x1,y1),(x2,y2),(0,230,230),2)
    lx = int(np.mean([x1 for x1,y1,x2,y2 in left_l]))  if left_l  else int(w*0.25)
    rx = int(np.mean([x1 for x1,y1,x2,y2 in right_l])) if right_l else int(w*0.75)
    thresh = int((rx-lx)*0.25)

    # YOLO
    results  = model(frame, conf=0.45, verbose=False)
    boxes    = results[0].boxes

    # Find blocking obstacle
    blocking = None
    for box in (boxes if boxes else []):
        cx    = float((box.xyxy[0][0]+box.xyxy[0][2])/2)
        cy    = float(box.xyxy[0][3])
        label = results[0].names[int(box.cls)]
        if float(box.conf)>0.5 and lx<cx<rx and cy>h*0.45 and label in OBSTACLE_CLASSES:
            blocking = (label, float(box.conf))
            break

    now = time.time()

    if blocking is None:
        if lane_hold > 0: lane_hold -= 1
        else:
            if lane_offset > 0:   lane_offset = max(0, lane_offset-8)
            elif lane_offset < 0: lane_offset = min(0, lane_offset+8)
            current_action = "MOVING"
            wait_start     = None
    else:
        label, conf = blocking
        decision, reason = OBSTACLE_CLASSES[label]

        if decision == "WAIT":
            if wait_start is None: wait_start = now
            waited = int(now - wait_start)
            if waited <= 10:
                current_action = f"WAIT ({10-waited}s)"
                if now - last_post > 2:
                    post("obstacle", {"label":label,"confidence":round(conf,2),
                                       "decision":"WAIT","reason":f"{reason} ({10-waited}s remaining)",
                                       "time":time.strftime("%H:%M:%S")})
                    last_post = now
            else:
                current_action = "REROUTING"
                wait_start     = None
                _do_reroute(label, conf, reason)

        elif decision == "LANE CHANGE":
            gL = check_gap(boxes,"left",lx,rx,w)
            gR = check_gap(boxes,"right",lx,rx,w)
            if gL:
                lane_offset=int(-(rx-lx)*0.5); lane_hold=5; current_action="LANE CHANGE LEFT"
            elif gR:
                lane_offset=int((rx-lx)*0.5);  lane_hold=5; current_action="LANE CHANGE RIGHT"
            else:
                current_action = "REROUTING"
                _do_reroute(label, conf, f"No gap found for {label}. Rerouting.")
            if now - last_post > 2:
                post("obstacle",{"label":label,"confidence":round(conf,2),
                                  "decision":"LANE CHANGE" if (gL or gR) else "REROUTE",
                                  "reason":reason,"time":time.strftime("%H:%M:%S")})
                last_post = now

        elif decision == "SLOW DOWN":
            current_action = "SLOW DOWN"
            if now - last_post > 3:
                post("obstacle", {"label": label, "confidence": round(conf, 2),
                                "decision": "SLOW DOWN", "reason": reason,
                                "time": time.strftime("%H:%M:%S")})
                last_post = now

    current_lane = "left" if lane_offset<-thresh else "right" if lane_offset>thresh else "centre"

    # Draw YOLO boxes
    for box in (boxes if boxes else []):
        lbl = results[0].names[int(box.cls)]
        c   = float(box.conf)
        if c < 0.45: continue
        x1,y1,x2,y2 = map(int, box.xyxy[0])
        col = (60,60,220) if lbl in OBSTACLE_CLASSES else (60,200,60)
        cv2.rectangle(frame,(x1,y1),(x2,y2),col,2)
        cv2.putText(frame,f"{lbl} {c:.2f}",(x1,max(y1-6,14)),
                    cv2.FONT_HERSHEY_SIMPLEX,0.47,col,1,cv2.LINE_AA)

    draw_robot(frame, lane_offset, current_action)

    spd = get_speed(current_action)
    label_route = "ALT ROUTE ⚠" if rerouted else "MAIN ROUTE"
    cv2.putText(frame,f"{label_route}  {current_action}  {spd}km/h",
                (8,24),cv2.FONT_HERSHEY_SIMPLEX,0.44,(255,255,255),1)
    cv2.putText(frame,f"Battery:{battery:.0f}%  GPS:{gps_index}/{len(gps_track)}",
                (8,44),cv2.FONT_HERSHEY_SIMPLEX,0.38,(180,180,180),1)

    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
    post("camera_frame", {"image":base64.b64encode(buf).decode(),
                           "action":current_action,"lane":current_lane,"speed":spd})

    if gps_track and gps_index >= len(gps_track) - 2:
        break

    time.sleep(FRAME_DELAY)

post("delivery_complete", {})
print("✅ Delivery complete!")
if cap: cap.release()