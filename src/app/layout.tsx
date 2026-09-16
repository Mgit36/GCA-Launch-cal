import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Launch Calendar Agent",
  description: "Founding TPM exercise — intake and update agent for the launch calendar",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
