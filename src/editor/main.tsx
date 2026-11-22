import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'

import { editor } from './store'

void editor.init().then(() => createRoot(document.getElementById('root')!).render(<App />))
