board.rect(80, 50, { layers: ["top", "bottom"], defaultLayer: "top", clearance: 0.35, edge: 2.5 });

block("buck-3v-a", ["U1", "L1", "C1", "C2", "C3", "C4", "R1", "R2"], "power", "3V_A buck converter");
block("buck-5v", ["U2", "L2", "C5", "C6", "C7", "C8", "R3", "R4"], "power", "5V buck converter");
block("buck-3v-b", ["U4", "L4", "C10", "C12", "C14", "C16", "R6", "R8"], "power", "3V_B buck converter");
block("input-connector", ["CN1"], "connector", "12 V input");
block("output-a-connector", ["CN2"], "connector", "3V_A output");
block("output-b-connector", ["CN3"], "connector", "3V_B output");
block("output-5v-connector", ["CN4"], "connector", "5V output");
module("power-conversion", ["buck-3v-a", "buck-5v", "buck-3v-b"]);

component("CN1").role("connector").edgePlace("top", { inset: 4, face: "any", align: "start" });
component("CN2").role("connector").edgePlace("top", { inset: 4, face: "any", align: "end" });
component("CN3").role("connector").edgePlace("bottom", { inset: 4, face: "any", align: "start" });
component("CN4").role("connector").edgePlace("bottom", { inset: 4, face: "any", align: "end" });

near(comp("U1"), comp("L1"), "critical");
near(comp("U1"), comp("C1"), "high");
near(comp("U1"), comp("C3"), "high");
near(comp("L1"), comp("C2"), "high");
near(comp("U1"), comp("R1"), "high");
near(comp("U1"), comp("R2"), "high");
near(comp("U2"), comp("L2"), "critical");
near(comp("U2"), comp("C5"), "high");
near(comp("U2"), comp("C7"), "high");
near(comp("L2"), comp("C6"), "high");
near(comp("U2"), comp("R3"), "high");
near(comp("U2"), comp("R4"), "high");
near(comp("U4"), comp("L4"), "critical");
near(comp("U4"), comp("C10"), "high");
near(comp("U4"), comp("C14"), "high");
near(comp("L4"), comp("C12"), "high");
near(comp("U4"), comp("R6"), "high");
near(comp("U4"), comp("R8"), "high");
