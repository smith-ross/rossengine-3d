import './styles.css'

if (location.hash.startsWith('#ross-client=')) {
  // a test player window for "Test multiplayer" (no editor)
  void import('./clientWindow').then((m) => m.runClientWindow())
} else {
  void Promise.all([import('react-dom/client'), import('./App'), import('./store')]).then(([{ createRoot }, { App }, { editor }]) =>
    editor.init().then(() => createRoot(document.getElementById('root')!).render(<App />)))
}
