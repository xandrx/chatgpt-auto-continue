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

## After targeted wakeups and registry pagination

Linux CI run 45996668695, commit a18632ab4d7127a9be4558e615d0f66cd358fd00. Same synthetic workload; 12 Rust tests and both HTTP/schema tests passed.

| Enrolled | Delivered | p50 ms | p95 ms | Idle RSS MiB | Sampled RSS MiB | Idle CPU % |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 8.93 | 10.65 | 6.40 | 7.61 | 0.00 |
| 50 | 50 | 38.76 | 44.16 | 6.49 | 10.44 | 0.00 |
| 100 | 100 | 78.76 | 89.08 | 6.40 | 12.51 | 0.00 |
| 500 | 500 | 53.93 | 70.48 | 6.56 | 15.36 | 0.00 |

The 100-parallel scenario p95 fell from 181.01 ms to 89.08 ms. All registered sessions were enumerated and all synthetic jobs delivered once. Compare single runs cautiously; runner scheduling differs. No production VPS benchmark yet. MCP dependency and observation interface are not included in these results.
