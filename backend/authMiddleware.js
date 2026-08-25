// Protege as rotas do painel: exige que o usuario tenha feito login com a
// senha definida em DASHBOARD_PASSWORD antes de ver qualquer dado ou
// conseguir enviar mensagens em nome das contas conectadas.
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }
  // Usa originalUrl (nao path): este middleware roda dentro de um router
  // montado em "/api" (veja server.js), e dentro dele req.path vem SEM o
  // prefixo "/api" — usar req.path aqui faria essa checagem nunca bater,
  // fazendo o servidor devolver a pagina de login (HTML) para uma chamada
  // da API, em vez de um erro 401 em JSON. O app.js do painel entende JSON
  // 401, nao HTML — sem isso, ele quebra tentando ler HTML como JSON assim
  // que a sessao expira ou fica invalida (ex: depois de trocar o SESSION_SECRET).
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(401).json({ error: "Nao autenticado" });
  }
  return res.redirect("/login.html");
}

module.exports = { requireLogin };
