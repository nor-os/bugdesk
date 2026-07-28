/**
 * agent_api_cheatsheet.js — content of the Agent-API reference panel.
 *
 * Imported by `tabs/agent_tab.js` and rendered into a SlideOutPanel
 * when the user clicks "API help" in the archetype editor header.
 * Static reference for everything user code can reach inside the four
 * loop bodies (`__init_brain__`, `observe`, `execute`, `adjust`). Kept
 * tight — full prose docs would belong in a separate handbook page.
 */

export const AGENT_API_CHEATSHEET_HTML = `
<div class="ea-help">
  <h4>Loop lifecycle (per tick)</h4>
  <ol class="ea-help__steps">
    <li><b>Observe</b> — sense the world. Read prices / news from
        <code>ctx.bus</code>; record samples on <code>self</code>. Brain frozen.</li>
    <li><b>Execute</b> — act on the world. Submit orders to
        <code>ctx.markets[id]</code>; emit transactions via
        <code>ctx.ledger.transfer</code>. Brain frozen.</li>
    <li><em>Markets clear → Godley flows → Transactions applied to the Ledger.</em></li>
    <li><b>Adjust</b> — update beliefs. <strong>Brain unfrozen here, here only.</strong>
        Mutate <code>self.brain.&lt;x&gt;</code>; refrozen on exit.</li>
  </ol>
  <p class="ea-help__note">
    <code>__init_brain__(self)</code> runs <em>once</em> at construction
    while the brain is writable — seed it with deques, regression
    models, custom containers.
  </p>
</div>

<div class="ea-help">
  <h4><code>ctx</code> — the per-tick handle</h4>
  <table class="ea-help__table">
    <tr><th><code>ctx.tick</code></th><td>current tick (int)</td></tr>
    <tr><th><code>ctx.rng</code></th><td>seeded <code>random.Random</code></td></tr>
    <tr>
      <th><code>ctx.markets[id]</code></th>
      <td>
        <code>.submit_buy(price=, volume=, agent=self)</code>,
        <code>.submit_sell(...)</code>,<br>
        <code>.last_price</code>, <code>.last_volume</code>,
        <code>.last_matches</code>
      </td>
    </tr>
    <tr>
      <th><code>ctx.bus</code></th>
      <td>
        <code>.publish(topic, value, delay=0)</code> — next-tick by default,<br>
        <code>.read(topic, default=None)</code>
      </td>
    </tr>
    <tr>
      <th><code>ctx.ledger</code></th>
      <td>
        <code>.balance(account_id) → float</code>,<br>
        <code>.transfer(debit, credit, kind=, amount=, note='')</code>
      </td>
    </tr>
    <tr>
      <th><code>ctx.agents</code></th>
      <td>
        <code>.archetype(key) → [Agent]</code>,
        <code>.find(id) → Agent | None</code>,<br>
        <code>.all() → [Agent]</code>,
        <code>.count(key=None) → int</code>,
        <code>.archetypes() → [str]</code>
      </td>
    </tr>
  </table>
</div>

<div class="ea-help">
  <h4><code>self</code> — the agent instance</h4>
  <table class="ea-help__table">
    <tr><th><code>self.agent_id</code></th><td>e.g. <code>"capitalist-0"</code></td></tr>
    <tr>
      <th><code>self.&lt;param&gt;</code></th>
      <td>value sampled from the param's distribution at construction
          (immutable by convention)</td>
    </tr>
    <tr>
      <th><code>self.brain.&lt;x&gt;</code></th>
      <td>persistent agent-private state — write only in <code>adjust</code>
          (raises <code>BrainWriteError</code> elsewhere)</td>
    </tr>
    <tr>
      <th><code>self.account(label)</code></th>
      <td>resolves an archetype account label to its ledger account id</td>
    </tr>
  </table>
</div>

<div class="ea-help">
  <h4>Conventions</h4>
  <ul>
    <li>Goods market: agents need accounts <code>Cash</code> (kind=cash, Asset)
        and <code>Goods</code> (kind=goods, Asset).</li>
    <li>Conservation per kind (Σ Asset = Σ Liability + Σ Equity) is
        enforced on every <code>Ledger.apply</code>.</li>
    <li>Same <code>seed</code> ⇒ same RNG ⇒ same param/account/event
        samples.</li>
    <li>Reading another agent's brain is fine; writing it is blocked.</li>
  </ul>
</div>

<div class="ea-help">
  <h4>Quick example</h4>
<pre class="ea-help__code"><code>def __init_brain__(self):
    import collections
    self.brain.expected_price = 1.0
    self.brain.history = collections.deque(maxlen=100)

def observe(self, ctx):
    last = ctx.markets["goods"].last_price
    if last is not None:
        self._last_obs = last     # ok to write self attrs

def execute(self, ctx):
    cash = ctx.ledger.balance(self.account("Cash"))
    if cash &gt;= 5:
        ctx.markets["goods"].submit_buy(
            price=self.brain.expected_price * 0.95,
            volume=1, agent=self)

def adjust(self, ctx):
    if hasattr(self, "_last_obs"):
        self.brain.history.append(self._last_obs)
        self.brain.expected_price = (
            self.ema_alpha * self._last_obs +
            (1 - self.ema_alpha) * self.brain.expected_price)
</code></pre>
</div>
`;
