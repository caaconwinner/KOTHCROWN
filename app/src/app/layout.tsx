import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { TopBar } from "@/components/TopBar";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://takethecrown.fun"),
  title: "take the crown",
  description: "the crown gets cheaper every minute. take it, earn the fees, get paid when someone takes it from you.",
  icons: { icon: [{ url: "/brand/favicon.svg", type: "image/svg+xml" }, { url: "/brand/favicon-32.png", sizes: "32x32" }], apple: "/brand/apple-touch-icon.png" },
  openGraph: { title: "take the crown", description: "the crown gets cheaper every minute.", images: ["/brand/og-1200x630.png"] },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: "#1b1d28" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>
          <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 pb-24 pt-4">
            <TopBar />
            <main className="flex flex-col gap-10">{children}</main>
            <footer className="text-center text-xs text-muted">
              king earns 95% of creator fees · 5% dev · every takeover burns 10%
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
