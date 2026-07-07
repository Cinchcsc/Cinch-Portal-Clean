import React from 'react';
export const metadata = { title: 'Cinch Self Storage Portal' };
export default function RootLayout({ children }) {
  return React.createElement('html', { lang: 'en' },
    React.createElement('body', { style: { margin: 0, fontFamily: 'Segoe UI, system-ui, sans-serif' } }, children)
  );
}
