# Dispatcher baseline performance

Linux GitHub Actions run 45996131553, commit dc785d767b466930f30397f2010233b32ea56a7e. Release binary; temporary SQLite database; HTTP loopback; synthetic tasks. No real ChatGPT clients.

| Enrolled | Max parallel waits | Delivered | p50 ms | p95 ms | Idle RSS MiB | Sampled RSS MiB | Idle CPU % |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 10 | 72.19 | 75.03 | 6.31 | 7.45 | 0.00 |
| 50 | 50 | 50 | 65.11 | 91.05 | 6.35 | 9.86 | 0.00 |
| 100 | 100 | 100 | 145.95 | 181.01 | 6.35 | 12.91 | 0.00 |
| 500 | 100 | 500 | 103.01 | 128.49 | 6.35 | 15.27 | 0.00 |

All 660 synthetic jobs delivered once and acknowledged. No duplicate claims observed. 10 Rust tests, 7 schema checks and HTTP smoke passed.

Limitations: one run per configuration, sampled RSS rather than peak RSS, idle CPU over a one-second window, loopback rather than WAN; the 500 case is batched. These results do not establish production capacity or 500 simultaneous waits. The measured delay includes HTTP enqueue and claim; it is not the local API p95 target.

Next comparison: per-session notifications and stable cursor pagination. A new CI run must confirm behavior; compare measurements cautiously because runner scheduling differs.
