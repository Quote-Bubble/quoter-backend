import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quoter API",
  description:
    "Backend service for Quoter: Google Geocoding and Solar proxying plus lead delivery.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          background: "#fff",
          color: "#0a0b0d",
        }}
      >
        {children}
      </body>
    </html>
  );
}
