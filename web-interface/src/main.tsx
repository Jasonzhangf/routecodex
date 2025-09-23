/**
 * Main entry point
 */

import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

import { StrictMode } from 'react';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);