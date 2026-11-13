import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { initializeSession, UnauthorizedError } from './api.ts';
import { board } from './store.ts';
import '../board.css';

async function start() {
  try {
    await initializeSession();
  } catch (error) {
    if (error instanceof UnauthorizedError) board.signOut();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void start();
