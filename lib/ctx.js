// lib/ctx.js — who is looking at the page, so every signed-in page gets the app menu without each route passing it.
// requireRole() sets it once per request; views/pages.js reads it. Public pages (sign-in, enquiry form, signing link) have none.
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();
module.exports = { enter: v => als.enterWith(v), get: () => als.getStore() };
