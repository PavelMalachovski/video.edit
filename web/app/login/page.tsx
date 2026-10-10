export default async function Login({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { e } = await searchParams;
  return (
    <main>
      <header className="top"><h1 className="logo">video<b>.</b>edit</h1></header>
      <form className="card" method="post" action="/api/login">
        <label htmlFor="password" className="label">Пароль</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        {e ? <div className="err">Неверный пароль</div> : null}
        <button type="submit" className="btn">Войти</button>
      </form>
    </main>
  );
}
