import type { ReactNode } from 'react'
import './globals.css'

export const metadata = { title: 'Mastra × A2A', description: 'Loan agents on separate servers, talking over the A2A protocol' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
