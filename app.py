from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from navigation import get_route
import json, time, queue

app = Flask(__name__)
CORS(app)

state = {
    "robot_status":    "Idle",
    "battery":         100,
    "speed":           0,
    "current_action":  "Waiting for order",
    "next_waypoint":   "",
    "distance_km":     0,
    "eta_minutes":     0,
    "route":           [],
    "robot_position":  None,
    "waypoint_index":  0,
    "delivery_status": "idle",
    "order_id":        "",
    "source":          "",
    "destination":     "",
    "obstacle_log":    [],
    "latest_frame":    "",
    "lane_status":     "centre",
    "traffic_status":  "Clear",
    "time_saved":      0,
    "current_road":    "",
}

event_queue = queue.Queue()

def push(event_type, data):
    event_queue.put({"type": event_type, "data": data})

@app.route("/stream")
def stream():
    def gen():
        while True:
            try:
                ev = event_queue.get(timeout=25)
                yield f"data: {json.dumps(ev)}\n\n"
            except queue.Empty:
                yield f"data: {json.dumps({'type':'ping'})}\n\n"
    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})

@app.route("/status")
def get_status():
    return jsonify(state)

@app.route("/start_delivery", methods=["POST"])
def start_delivery():
    data   = request.get_json()
    source = data.get("source", "")
    dest   = data.get("destination", "")
    route_data, error = get_route(source, dest)
    if error:
        return jsonify({"ok": False, "error": error}), 400
    import random
    state.update({
        "route":           route_data["waypoints"],
        "distance_km":     route_data["distance_km"],
        "eta_minutes":     route_data["eta_minutes"],
        "delivery_status": "in_transit",
        "robot_status":    "Active",
        "source":          source,
        "destination":     dest,
        "order_id":        f"ORD-{random.randint(1000,9999)}",
        "waypoint_index":  0,
        "speed":           24,
        "current_action":  "Moving to destination",
        "battery":         100,
        "obstacle_log":    [],
    })
    push("route", {
        "route":       route_data["waypoints"],
        "source":      source,
        "destination": dest,
        "distance_km": route_data["distance_km"],
        "eta_minutes": route_data["eta_minutes"],
        "order_id":    state["order_id"],
    })
    push("status", {"delivery_status": "in_transit"})
    return jsonify({"ok": True, **route_data, "order_id": state["order_id"]})

@app.route("/position", methods=["POST"])
def update_position():
    data = request.get_json()
    state["robot_position"] = [data["lat"], data["lng"]]
    state["waypoint_index"] = data.get("index", 0)
    total = len(state["route"])
    idx   = state["waypoint_index"]
    if total > 0:
        remaining = state["distance_km"] * (1 - idx/total)
        state["eta_minutes"] = max(0, int((remaining / 20) * 60))
    push("position", {"lat": data["lat"], "lng": data["lng"],
                       "index": idx, "eta": state["eta_minutes"]})
    return jsonify({"ok": True})

@app.route("/obstacle", methods=["POST"])
def obstacle():
    data  = request.get_json()
    entry = {
        "time":       data.get("time", time.strftime("%H:%M:%S")),
        "event":      data.get("label", "Unknown"),
        "decision":   data.get("decision", "WAIT"),
        "reason":     data.get("reason", "Obstacle detected"),
        "confidence": data.get("confidence", 0),
    }
    state["obstacle_log"].insert(0, entry)
    state["obstacle_log"] = state["obstacle_log"][:20]
    state["current_action"] = entry["decision"]
    push("obstacle", entry)
    push("ai_decision", {"decision": entry["decision"],
                          "reason":   entry["reason"],
                          "label":    entry["event"]})
    return jsonify({"ok": True})

@app.route("/camera_frame", methods=["POST"])
def camera_frame():
    data = request.get_json()
    state["latest_frame"]   = data.get("image", "")
    state["current_action"] = data.get("action", state["current_action"])
    state["lane_status"]    = data.get("lane", "centre")
    state["speed"]          = data.get("speed", 24)
    push("frame", {"image":  state["latest_frame"],
                   "action": state["current_action"],
                   "lane":   state["lane_status"],
                   "speed":  state["speed"]})
    return jsonify({"ok": True})

@app.route("/battery", methods=["POST"])
def battery():
    data = request.get_json()
    state["battery"] = data["level"]
    push("battery", {"level": data["level"]})
    return jsonify({"ok": True})

@app.route("/delivery_complete", methods=["POST"])
def delivery_complete():
    state["delivery_status"] = "delivered"
    state["robot_status"]    = "Idle"
    state["current_action"]  = "Delivery Complete"
    state["speed"]           = 0
    push("status", {"delivery_status": "delivered"})
    return jsonify({"ok": True})

@app.route("/robot_status", methods=["POST"])
def robot_status():
    data = request.get_json()
    state["robot_status"]   = data.get("status", state["robot_status"])
    state["current_action"] = data.get("action", state["current_action"])
    state["lane_status"]    = data.get("lane",   state["lane_status"])
    push("robot_update", data)
    return jsonify({"ok": True})

@app.route("/obstacle_log")
def get_log():
    return jsonify(state["obstacle_log"])

@app.route("/update_route", methods=["POST"])
def update_route():
    data  = request.get_json()
    route = data.get("route", [])
    state["route"] = route
    push("route", {
        "route":       route,
        "source":      state.get("source",""),
        "destination": state.get("destination",""),
        "is_reroute":  data.get("is_reroute", False),
    })
    return jsonify({"ok": True})

@app.route("/traffic_update", methods=["POST"])
def traffic_update():
    data = request.get_json()
    state["traffic_status"] = data.get("status", "Clear")
    state["time_saved"]     = data.get("saved", 0)
    push("traffic", {
        "status": data.get("status", "Clear"),
        "saved":  data.get("saved",  0),
    })
    return jsonify({"ok": True})

if __name__ == "__main__":
    print("Flask running at http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)