# Bug list

IDs match the tests in this folder and the bug table in the test report.
Bugs with a test are tracked there (`bug(` = still open, `it(` = fixed); this
file holds the ones logged without a test yet.

- **B19** — open: an unpaid online order is listed in My Orders as PENDING with "Awaiting confirmation — your 15-day delivery window starts once we approve this order", and after the sweeper expires it, as EXPIRED with the same note — an order the customer never paid for.
- **B20** — fixed in `c6a602c`: paying online and then selecting Cash on Delivery before Complete Order placed a second (COD) order for the same bag.
- **B21** — fixed (see the `fix(B21)` commit): a customer who paid online and never selected Complete Order kept their bag, so they could check out and pay for the same pieces again.

## Unexplained observations

Not bugs yet; written down so a recurrence can be recognised.

- **E2E sign-out (2026-10-10)** — once, in the full E2E run straight after a failed Shop Price step (during the M1 fix), four later mobile flows failed because the customer had been signed out (`wishlist has undefined`, `cart.some is not a function`, `/dashboard/adminDashboard` ending on `/login`). No 429s in the API log. It did not happen in the next three full runs; not investigated.
