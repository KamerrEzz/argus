import type { ReactNode } from 'react';
import './globals.css';
import { SessionProvider } from '@/components/layout';
import { ToastProvider } from '@/components/toast';

export const metadata: {
  title: { default: string; template: string };
  description: string;
} = {
  title: {
    default: 'AI Code Review Console',
    template: '%s · AI Code Review',
  },
  description: 'Dashboard for AI-powered pull request review and QA runs.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-canvas text-ink antialiased">
        <ToastProvider>
          <SessionProvider>{children}</SessionProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
