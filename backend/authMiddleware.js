// Protege as rotas do painel: exige que o usuario tenha feito login com a
// senha definida em DASHBOARD_PASSWORD antes de ver qualquer dado ou
// conseguir enviar mensagens em nome das contas conectadas.
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }
  // originalUrl, nao path: dentro de um router montado com
  // app.use("/api", ...) o req.path vem SEM o /api (ex: "/flex/estado"),
  // entao o teste falhava e a chamada de API era redirecionada para a tela
  // de login. O front recebia o HTML do login onde esperava JSON e
  // quebrava com "Unexpected token '<'". Vale para /api/prazos,
  // /api/conversations, /api/questions e /api/flex.
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(401).json({ error: "Nao autenticado" });
  }
  return res.redirect("/login.html");
}

module.exports = { requireLogin };
