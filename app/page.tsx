export default function Home() {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "72px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Quoter API</h1>
      <p style={{ color: "#3d4148", lineHeight: 1.6 }}>
        Backend service for Quoter. It proxies Google Geocoding and Solar
        requests with server-side keys and delivers completed leads to the
        configured webhook. There is no UI here; the frontend lives in the
        quoter-widget repository.
      </p>
      <ul style={{ color: "#3d4148", lineHeight: 2, paddingLeft: 20 }}>
        <li>
          <code>POST /api/geocode</code> — address to coordinates
        </li>
        <li>
          <code>POST /api/solar</code> — roof geometry from Google Solar
        </li>
        <li>
          <code>POST /api/lead</code> — lead delivery to the roofer webhook
        </li>
      </ul>
    </main>
  );
}
