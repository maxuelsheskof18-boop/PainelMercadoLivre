// Protege as rotas do painel: exige que o usuario tenha feito login com a
// senha definida em DASHBOARD_PASSWORD antes de ver qualquer dado ou
// conseguir enviar mensagens em nome das contas conectadas.
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Nao autenticado" });
  }
  return res.redirect("/login.html");
}

module.exports = { requireLogin };
