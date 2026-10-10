export default async function Login({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { e } = await searchParams;
  return (
    <main>
      <h1>video<b>.</b>edit</h1>
      <form className="card" method="post" action="/api/login">
        <label htmlFor="password">Пароль</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        {e ? <div className="err">Неверный пароль</div> : null}
        <button type="submit">Войти</button>
      </form>
    </main>
  );
}
