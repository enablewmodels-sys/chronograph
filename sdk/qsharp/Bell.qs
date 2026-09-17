namespace Chronograph.Examples {
    operation Bell() : Int[] {
        use qubits = Qubit[2];
        H(qubits[0]);
        CNOT(qubits[0], qubits[1]);
        let a = MResetZ(qubits[0]);
        let b = MResetZ(qubits[1]);
        return [a == One ? 1 | 0, b == One ? 1 | 0];
    }
}
