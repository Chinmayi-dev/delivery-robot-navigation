import osmnx as ox
import networkx as nx
import os, pickle

GRAPH_CACHE = "D:/DeliveryRobot/maps/mysuru_graph.pkl"
os.makedirs("D:/DeliveryRobot/maps", exist_ok=True)

KNOWN_COORDS = {
    "SJCE Campus Mysuru":           (12.318616797088039, 76.61473365314532),
    "Aishwarya Petrol Bunk Mysuru": (12.324185582801741, 76.6129730655306),

    "Mysore Palace":                (12.305351670285143, 76.65517489547314),
    "Hotel RRR Mysuru":             (12.30864285774697, 76.65885581347007),
    "JSS Hospital Mysuru":          (12.29580249083876, 76.65564008012915),
    "Aroma The Bakers":             (12.307252489806855, 76.61613804248883),
    "Mysuru Railway Station":       (12.316396970857136, 76.64543698198119),
}

def load_graph():
    if os.path.exists(GRAPH_CACHE):
        print("Loading Mysuru road map from cache...")
        with open(GRAPH_CACHE, "rb") as f:
            return pickle.load(f)
    print("Downloading Mysuru roads from OpenStreetMap...")
    G = ox.graph_from_place("Mysuru, Karnataka, India", network_type="drive")
    with open(GRAPH_CACHE, "wb") as f:
        pickle.dump(G, f)
    print("Saved.")
    return G

G = load_graph()

def get_route(source_name, destination_name):
    # Step 1: Get coordinates
    src_coords  = KNOWN_COORDS.get(source_name)
    dest_coords = KNOWN_COORDS.get(destination_name)

    if src_coords is None:
        try:
            src_coords = ox.geocode(f"{source_name}, Mysuru, Karnataka, India")
            print(f"Geocoded source: {source_name} → {src_coords}")
        except:
            return None, f"Could not find location: {source_name}"

    if dest_coords is None:
        try:
            dest_coords = ox.geocode(f"{destination_name}, Mysuru, Karnataka, India")
            print(f"Geocoded destination: {destination_name} → {dest_coords}")
        except:
            return None, f"Could not find location: {destination_name}"

    print(f"Source     : {source_name} → {src_coords}")
    print(f"Destination: {destination_name} → {dest_coords}")

    # Step 2: Find nearest road nodes 
    src_node  = ox.nearest_nodes(G, src_coords[1],  src_coords[0])
    dest_node = ox.nearest_nodes(G, dest_coords[1], dest_coords[0])

    # Step 3: Dijkstra shortest path
    try:
        nodes = nx.shortest_path(G, src_node, dest_node, weight="length")
    except nx.NetworkXNoPath:
        return None, "No road path found between these locations."

    waypoints = [[G.nodes[n]["y"], G.nodes[n]["x"]] for n in nodes]

    # Step 4: Calculate distance and ETA
    distance = sum(
        ox.distance.great_circle(
            waypoints[i][0], waypoints[i][1],
            waypoints[i+1][0], waypoints[i+1][1]
        ) for i in range(len(waypoints)-1)
    ) / 1000

    eta_minutes = int((distance / 20) * 60)

    return {
        "waypoints":    waypoints,
        "distance_km":  round(distance, 2),
        "eta_minutes":  eta_minutes,
        "total_points": len(waypoints)
    }, None


if __name__ == "__main__":
    result, error = get_route("SJCE Campus Mysuru", "Aishwarya Petrol Bunk Mysuru")
    if error:
        print("Error:", error)
    else:
        print(f"Route found : {result['total_points']} waypoints")
        print(f"Distance    : {result['distance_km']} km")
        print(f"ETA         : {result['eta_minutes']} mins")
        print(f"First point : {result['waypoints'][0]}")
        print(f"Last point  : {result['waypoints'][-1]}")