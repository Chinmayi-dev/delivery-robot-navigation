# Multi-Modal Sensor Fusion and AI-Based Navigation for Delivery Robots

A software simulation of an AI-based autonomous delivery robot 
navigating real Indian urban roads in Mysuru, Karnataka.

## Overview
- YOLOv8n trained on Indian Driving Dataset (IDD) for 
  Indian-specific obstacle detection
- Dijkstra's algorithm on Mysuru OpenStreetMap road graph
- GPS-video synchronisation for real-time map tracking
- Flask SSE + React dashboard for live monitoring

## Tech Stack
Python, Flask, React.js, YOLOv8, OpenCV, osmnx, 
NetworkX, React Leaflet, OpenStreetMap

## Project Structure
- app.py — Flask backend with 12 REST endpoints and SSE stream
- navigation.py — Dijkstra routing on OSM graph
- video_robot.py — AI pipeline (YOLO, lane detection, 
  decision engine, GPS sync)
- Dashboard.js — React frontend with live map and camera feed

## How to Run
1. pip install -r requirements.txt
2. python app.py
3. cd dashoard && npm install && npm start
4. python video_robot.py

## Results
- mAP50: 0.44 | mAP50-95: 0.30
- GPS accuracy: ~4.2 metres
- SSE latency: under 200ms
- Validated across 5 delivery routes in Mysuru
