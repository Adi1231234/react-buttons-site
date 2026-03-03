import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)
  const [message, setMessage] = useState('לחץ על כפתור כלשהו 👇')
  const [dark, setDark] = useState(false)
  const [likes, setLikes] = useState(0)
  const [emoji, setEmoji] = useState('😊')

  const emojis = ['😊', '🚀', '🔥', '💡', '🎉', '⚡', '🌈', '💻', '🎯', '👾']

  const randomEmoji = () => {
    setEmoji(emojis[Math.floor(Math.random() * emojis.length)])
    setMessage('אימוג׳י חדש!')
  }

  return (
    <div className={`app ${dark ? 'dark' : 'light'}`}>
      <header>
        <h1>{emoji} עמוד הכפתורים {emoji}</h1>
        <p className="subtitle">{message}</p>
      </header>

      <section className="button-grid">
        <button className="btn primary" onClick={() => { setCount(c => c + 1); setMessage(`לחצת ${count + 1} פעמים!`) }}>
          🖱️ לחיצות: {count}
        </button>

        <button className="btn danger" onClick={() => { setCount(0); setMessage('אופס, אפסנו!') }}>
          🗑️ אפס מונה
        </button>

        <button className="btn success" onClick={() => { setLikes(l => l + 1); setMessage(`${likes + 1} לייקים ❤️`) }}>
          ❤️ לייק: {likes}
        </button>

        <button className="btn warning" onClick={randomEmoji}>
          🎲 אימוג׳י רנדומלי
        </button>

        <button className="btn info" onClick={() => { setDark(d => !d); setMessage(dark ? 'מצב בהיר ☀️' : 'מצב כהה 🌙') }}>
          {dark ? '☀️ מצב בהיר' : '🌙 מצב כהה'}
        </button>

        <button className="btn gradient" onClick={() => setMessage('וואו, כפתור גרדיאנט! 🌈')}>
          🌈 גרדיאנט
        </button>

        <button className="btn outline" onClick={() => setMessage('מינימליזם זה יפה ✨')}>
          ✨ מינימלי
        </button>

        <button className="btn pulse" onClick={() => setMessage('אני פועם! 💓')}>
          💓 פולס
        </button>

        <button className="btn glass" onClick={() => setMessage('אפקט זכוכית 🪟')}>
          🪟 זכוכית
        </button>

        <button className="btn neon" onClick={() => setMessage('ניאון! ⚡')}>
          ⚡ ניאון
        </button>

        <button className="btn retro" onClick={() => alert('הודעה רטרו! 📟')}>
          📟 אלרט רטרו
        </button>

        <button className="btn big" onClick={() => { if (confirm('בטוח?')) setMessage('אישרת! 🎉'); else setMessage('ביטלת 😅') }}>
          🤔 קונפירם
        </button>
      </section>

      <footer>
        <p>נבנה עם React + Vite ⚛️</p>
      </footer>
    </div>
  )
}

export default App
