# The five-stage RISC-V pipeline

Drag the instruction or press Play. Each stage highlights its section below.

<Artifact src="./datapath.artifact.html" name="datapath" height="170" />

<Artifact src="./regfile.artifact.html" name="regfile" height="110" />

## Instruction fetch {#if}

The PC indexes instruction memory. The fetched instruction goes into the IF/ID pipeline register and the PC moves to PC + 4.

## Instruction decode {#id}

The control unit decodes the opcode. The register file reads rs1 and rs2 in the same cycle.

## Execute {#ex}

The ALU computes the result. For add it adds the two register values.

## Memory access {#mem}

Loads and stores use data memory here. Arithmetic instructions pass straight through.

## Write back {#wb}

The result is written into rd, which is x3 for add x3, x1, x2.
