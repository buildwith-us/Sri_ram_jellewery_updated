# Bug list

IDs match the tests in this folder and the bug table in the test report.
Bugs with a test are tracked there (`bug(` = still open, `it(` = fixed); this
file holds the ones logged without a test yet.

- **B19** — open: an unpaid online order (`pending`) appears in My Orders, then disappears when the sweeper expires it, with nothing telling the customer why.
- **B20** — fixed in `c6a602c`: paying online and then selecting Cash on Delivery before Complete Order placed a second (COD) order for the same bag.
- **B21** — fixed (see the `fix(B21)` commit): a customer who paid online and never selected Complete Order kept their bag, so they could check out and pay for the same pieces again.
