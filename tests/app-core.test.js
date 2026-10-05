const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

function fresh() { return createApp(); }

test("escapeHtml экранирует спецсимволы", () => {
  const a = fresh();
  assert.equal(a.run(`escapeHtml('<a href="x" onclick=\\'y\\'>&')`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  assert.equal(a.run(`escapeHtml(null)`), "");
  a.close();
});

test("truncate / initials / highlightRaw", () => {
  const a = fresh();
  assert.equal(a.run(`truncate("abcdefghij", 5)`), "abcd…");
  assert.equal(a.run(`truncate("abc", 5)`), "abc");
  assert.equal(a.run(`truncate(null, 5)`), "");
  assert.equal(a.run(`initials("anna")`), "AN");
  assert.equal(a.run(`initials("")`), "?");
  assert.match(a.run(`highlightRaw("hello world", "wor")`), /<mark[^>]*>wor<\/mark>/);
  a.close();
});

test("linkPreviewCardHtml: только http(s), всё экранируется", () => {
  const a = fresh();
  assert.equal(a.run(`linkPreviewCardHtml({url:"javascript:alert(1)"})`), "");
  assert.equal(a.run(`linkPreviewCardHtml(null)`), "");
  const html = a.run(`linkPreviewCardHtml({url:"https://e.com/?a=1&b=2",title:"<b>t</b>",description:"d",siteName:"s",image:"javascript:x"})`);
  assert.match(html, /&lt;b&gt;t&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(a.run(`linkPreviewCardHtml({url:"https://e.com",image:"https://e.com/i.png"})`), /<img[^>]+src="https:\/\/e.com\/i.png"/);
  a.close();
});

test("avatarCircleHtml: data-URL только по строгому шаблону", () => {
  const a = fresh();
  assert.match(a.run(`avatarCircleHtml({name:"Bob",avatar:"data:image/png;base64,AAAA"})`), /background-image/);
  const bad = a.run(`avatarCircleHtml({name:"<i>",avatar:"data:image/png;base64,AA');x:('"})`);
  assert.doesNotMatch(bad, /background-image/);
  assert.doesNotMatch(bad, /<I>|<i>/);
  a.close();
});

test("unreadCount / trimMessages / ensureContactEntry", () => {
  const a = fresh();
  assert.equal(a.run(`unreadCount({messages:[{from:"them"},{from:"them",readAckSent:true},{from:"me"}]})`), 1);
  assert.equal(a.run(`(() => { const c = {messages: Array.from({length: MAX_MESSAGES_PER_CHAT + 5}, (_, i) => ({id: i})) }; trimMessages(c); return c.messages.length + ":" + c.messages[0].id; })()`), "5000:5");
  assert.equal(a.run(`(() => { const c = ensureContactEntry("u1", "Ann"); const d = ensureContactEntry("u1", "Zed"); return c === d && c.name; })()`), "Ann");
  a.close();
});

test("buildGroupInviteCode / parseGroupInviteCode", () => {
  const a = fresh();
  a.run(`Store.myId = "me1"; state.contacts.set("g1", {id:"g1", isGroup:true, name:"Team", members:[], messages:[]})`);
  const code = a.run(`buildGroupInviteCode("g1")`);
  assert.match(code, /^ether:\/\/group\?/);
  const parsed = a.run(`JSON.stringify(parseGroupInviteCode(${JSON.stringify(code)}))`);
  assert.deepEqual(JSON.parse(parsed), { groupId: "g1", refId: "me1", refName: "", groupName: "Team" });
  assert.equal(a.run(`buildGroupInviteCode("nope")`), null);
  assert.equal(a.run(`parseGroupInviteCode("http://x")`), null);
  assert.equal(a.run(`parseGroupInviteCode("ether://group?gid=a")`), null);
  assert.equal(a.run(`parseGroupInviteCode("")`), null);
  a.close();
});

test("persistContactsNow → loadContacts возвращает контакты и группы", () => {
  const a = fresh();
  a.run(`state.contacts.set("c1", {id:"c1", name:"Ann", raw:"", managed:true, messages:[{id:"m1", from:"them", text:"hi", ts:1}], lastActivity:5, archived:true, muted:false, blocked:false});
         state.contacts.set("g1", {id:"g1", name:"G", managed:true, isGroup:true, members:[{id:"c1", name:"Ann"}], createdBy:"c1", messages:[], lastActivity:1}); persistContacts(); persistContactsNow();`);
  a.run(`state.contacts.clear(); loadContacts();`);
  assert.equal(a.run(`state.contacts.get("c1").archived`), true);
  assert.equal(a.run(`state.contacts.get("c1").messages.length`), 1);
  assert.equal(a.run(`state.contacts.get("g1").isGroup`), true);
  assert.equal(a.run(`state.contacts.get("g1").members.length`), 1);
  a.close();
});

test("loadContacts при битом JSON показывает тост и не падает", () => {
  const a = fresh();
  a.window.localStorage.setItem("ether.contacts", "{broken");
  a.run(`state.contacts.clear(); loadContacts();`);
  assert.equal(a.run(`Array.from(state.contacts.keys()).filter((k) => k !== SELF_CHAT_ID).length`), 0);
  assert.ok(a.document.querySelector("#toast").textContent.length > 0);
  a.close();
});

test("updateAppBadge не считает самочат", () => {
  const a = fresh();
  a.run(`state.contacts.set("s", {id:"s", isSelf:true, messages:[{from:"them"}]}); state.contacts.set("o", {id:"o", messages:[{from:"them"},{from:"them"}]}); updateAppBadge();`);
  assert.equal(a.document.querySelector("#tab-chats-badge").textContent, "2");
  a.close();
});
