const express = require("express");
const router = express.Router();

router.post("/login", express.json(), (req, res) => {
  const { password } = req.body || {};
  if (password && password === process.env.DASHBOARD_PASSWORD) {
    req.session.loggedIn = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Senha incorreta" });
});

router.post("/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

module.exports = router;
