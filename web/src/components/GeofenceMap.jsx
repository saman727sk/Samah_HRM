/** Click the map to drop the office pin; the circle shows the check-in radius. */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/** `focus`: change it to re-centre the map on lat/lng (e.g. after "Use my current location"). */
export default function GeofenceMap({ lat, lng, radius, onPick, focus }) {
  const box = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  useEffect(() => {
    map.current = L.map(box.current).setView([lat ?? 30.3753, lng ?? 69.3451], lat != null ? 16 : 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map.current);
    map.current.on('click', (e) => onPick(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))));
    // The map is created inside a modal that is still laying out; re-measure once it has its final size.
    const resize = setTimeout(() => map.current?.invalidateSize(), 150);
    return () => { clearTimeout(resize); map.current.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    layer.current?.remove();
    if (lat == null || lng == null) return;
    layer.current = L.layerGroup([
      L.circleMarker([lat, lng], { radius: 6, color: '#2a63c4', fillOpacity: 1 }),
      L.circle([lat, lng], { radius: radius || 100, color: '#2a63c4', weight: 2, fillOpacity: 0.12 }),
    ]).addTo(map.current);
  }, [lat, lng, radius]);
  useEffect(() => {
    if (focus && lat != null && lng != null) map.current?.setView([lat, lng], 17);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={box} className="leaflet-container" role="application" aria-label="Map: click to set the office location" />;
}
