# Bill of materials

Catalogue-resolved components for the three independent buck rails. The catalogue `part_uuid` identifies the selected part record; the provided local footprint files are included with the project.

| References | Qty | Manufacturer part / value | Notes |
|---|---:|---|---|
| U1, U2, U4 | 3 | Texas Instruments TPS62130ARGTR | Adjustable VQFN-16 buck regulator with exposed pad |
| L1, L2, L4 | 3 | Bourns SRP4020TA-2R2M, 2.2 µH | 4 A Irms, 6 A Isat, 61 mΩ max DCR |
| C1, C5, C10 | 3 | Samsung CL32B106KBJNNNE, 10 µF 50 V X7R | 1210 input capacitor; check effective capacitance at 12 V bias |
| C2, C6, C12 | 3 | Samsung CL21A226MAQNNNE, 22 µF 25 V X5R | 0805 output capacitor; check effective capacitance at 3/5 V bias |
| C3, C7, C14 | 3 | Samsung CL10B104KB8NNNC, 100 nF 50 V X7R | 0603 AVIN bypass |
| C4, C8, C16 | 3 | Samsung CL10B332KB8NNNC, 3.3 nF 50 V X7R | 0603 soft-start capacitor |
| R1, R6 | 2 | Yageo RC0603FR-07274KL, 274 kΩ 1% | 3 V divider top resistors |
| R3 | 1 | Yageo RC0603FR-07523KL, 523 kΩ 1% | 5 V divider top resistor |
| R2, R4, R8 | 3 | Yageo RC0603FR-07100KL, 100 kΩ 1% | Divider bottom resistors |
| CN1–CN4 | 4 | JST B2B-XH-AM, 1×2, 2.5 mm | Board headers; cable housings and crimp contacts are external |

## Catalogue part UUIDs

- TPS62130ARGTR: `a03a2434c32e411a8a3b39b8122990ac`
- SRP4020TA-2R2M: `e4acfdcf505549e582e2188850bfb5af`
- CL32B106KBJNNNE: `b81d050433924fbabb0707884a45c79e`
- CL21A226MAQNNNE: `9583d53cf848486a9d523fcaf153a729`
- CL10B104KB8NNNC: `49c50a09a6674d6b9c72fcc3adebcbca`
- CL10B332KB8NNNC: `82091d53505c4d18b18f20c707e780dc`
- RC0603FR-07274KL: `157654ba9bbe4a0c9d7a3d08a80a710e`
- RC0603FR-07523KL: `02a312b2bf584c26990ca6426cbe3031`
- RC0603FR-07100KL: `63f36718007a410e91ecdc02f05d06ac`
- B2B-XH-AM: `8d9f47f119a448729f01b3bb1d0cf269`
