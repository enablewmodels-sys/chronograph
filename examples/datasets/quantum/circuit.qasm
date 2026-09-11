OPENQASM 3.0;
include "stdgates.inc";
// A static three-qubit preparation circuit; no measurement or hardware execution.
qubit[3] q;
h q[0];
x q[2];
cx q[0], q[1];
rz(pi/2) q[1];
swap q[1], q[2];
