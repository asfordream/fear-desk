import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FearDesk · 美股恐慌观察",
  description: "真实日线、可追溯恐慌指数与独立形态判断。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
