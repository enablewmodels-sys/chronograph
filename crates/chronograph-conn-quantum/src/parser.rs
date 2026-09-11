//! Experimental lowering of a bounded, explicitly supported unitary OpenQASM 3 subset.
use crate::{Circuit, Error, Operation, Result};
use oq3_parser::LexedStr;
use oq3_syntax::{
    AstNode, SourceFile,
    ast::{Expr, Stmt},
};
use std::collections::BTreeSet;

fn tokens(text: &str) -> Result<Vec<String>> {
    let lex = LexedStr::new(text);
    if let Some((_, error)) = lex.errors().next() {
        return Err(Error::Invalid(format!("OpenQASM lexer: {error}")));
    }
    Ok((0..lex.len())
        .filter(|i| !lex.kind(*i).is_trivia())
        .map(|i| lex.text(i).to_owned())
        .collect())
}
fn identifier(value: &str) -> bool {
    value
        .bytes()
        .enumerate()
        .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i != 0 && b.is_ascii_digit()))
        && !value.is_empty()
        && !matches!(
            value,
            "pi" | "tau"
                | "euler"
                | "U"
                | "h"
                | "x"
                | "y"
                | "z"
                | "s"
                | "sdg"
                | "t"
                | "tdg"
                | "rx"
                | "ry"
                | "rz"
                | "cx"
                | "cz"
                | "swap"
        )
}
fn number(tokens: &[String]) -> Result<f64> {
    let text = tokens.concat();
    let (sign, rest) = if let Some(s) = text.strip_prefix('-') {
        (-1.0, s)
    } else {
        (1.0, text.strip_prefix('+').unwrap_or(&text))
    };
    let value = if rest == "pi" {
        std::f64::consts::PI
    } else if let Some(divisor) = rest.strip_prefix("pi/") {
        let d: f64 = divisor.parse().map_err(|_| {
            Error::Invalid("parameter divisor must be a finite nonzero number".into())
        })?;
        if d == 0.0 || !d.is_finite() {
            return Err(Error::Invalid("invalid pi divisor".into()));
        }
        std::f64::consts::PI / d
    } else {
        if rest.is_empty()
            || !rest
                .bytes()
                .all(|b| b.is_ascii_digit() || b".eE+-".contains(&b))
        {
            return Err(Error::Invalid(
                "parameters support signed numeric literals, pi, and pi/n only".into(),
            ));
        }
        rest.parse::<f64>()
            .map_err(|_| Error::Invalid("invalid numeric gate parameter".into()))?
    };
    let value = sign * value;
    if !value.is_finite() {
        return Err(Error::Invalid("nonfinite gate parameter".into()));
    }
    Ok(value)
}
fn gate(tokens: &[String], register: &str, qubits: u32, array_register: bool) -> Result<Operation> {
    let name = tokens
        .first()
        .ok_or_else(|| Error::Invalid("empty gate call".into()))?
        .clone();
    let (arity, parameters) = match name.as_str() {
        "h" | "x" | "y" | "z" | "s" | "sdg" | "t" | "tdg" => (1, 0),
        "rx" | "ry" | "rz" => (1, 1),
        "U" => (1, 3),
        "cx" | "cz" | "swap" => (2, 0),
        _ => return Err(Error::Invalid(format!("unsupported static gate {name}"))),
    };
    let mut pos = 1;
    let mut params = Vec::new();
    if tokens.get(pos).is_some_and(|s| s == "(") {
        pos += 1;
        let start = pos;
        while pos < tokens.len() && tokens[pos] != ")" {
            pos += 1;
        }
        if pos == tokens.len() {
            return Err(Error::Invalid("unclosed gate arguments".into()));
        }
        for part in tokens[start..pos].split(|s| s == ",") {
            params.push(number(part)?);
        }
        pos += 1;
    }
    if params.len() != parameters {
        return Err(Error::Invalid(format!(
            "{name} requires {parameters} parameters"
        )));
    }
    let mut targets = Vec::new();
    loop {
        if tokens.get(pos).map(String::as_str) != Some(register) {
            return Err(Error::Invalid(
                "operand must name the declared qubit register".into(),
            ));
        }
        pos += 1;
        let index = if tokens.get(pos).is_some_and(|s| s == "[") {
            pos += 1;
            let n: u32 = tokens
                .get(pos)
                .ok_or_else(|| Error::Invalid("missing qubit index".into()))?
                .parse()
                .map_err(|_| {
                    Error::Invalid("qubit index must be a nonnegative decimal integer".into())
                })?;
            pos += 1;
            if tokens.get(pos).map(String::as_str) != Some("]") {
                return Err(Error::Invalid(
                    "only single static qubit indices are supported".into(),
                ));
            }
            pos += 1;
            n
        } else if !array_register {
            0
        } else {
            return Err(Error::Invalid(
                "register broadcasting is unsupported; index each operand".into(),
            ));
        };
        if index >= qubits || targets.contains(&index) {
            return Err(Error::Invalid(
                "qubit out of range or repeated in a gate".into(),
            ));
        }
        targets.push(index);
        if tokens.get(pos).map(String::as_str) == Some(",") {
            pos += 1;
        } else {
            break;
        }
    }
    if targets.len() != arity
        || tokens.get(pos).map(String::as_str) != Some(";")
        || pos + 1 != tokens.len()
    {
        return Err(Error::Invalid(format!(
            "wrong {name} arity or unsupported gate suffix"
        )));
    }
    Ok(Operation {
        gate: name,
        qubits: targets,
        parameters: params,
        predecessors: Vec::new(),
    })
}
pub fn parse(source: &str) -> Result<Circuit> {
    if source.is_empty() || source.len() > 256 * 1024 {
        return Err(Error::Invalid(
            "OpenQASM source must contain 1–262144 bytes".into(),
        ));
    }
    let all = tokens(source)?;
    let mut depth = 0i32;
    let mut statement_tokens = 0;
    for token in &all {
        statement_tokens += 1;
        match token.as_str() {
            "(" | "[" => {
                depth += 1;
                if depth > 16 {
                    return Err(Error::Invalid(
                        "OpenQASM nesting exceeds static subset limit".into(),
                    ));
                }
            }
            ")" | "]" => {
                depth -= 1;
                if depth < 0 {
                    return Err(Error::Invalid("unbalanced OpenQASM delimiters".into()));
                }
            }
            "{" | "}" => {
                return Err(Error::Invalid(
                    "dynamic/custom-gate blocks are outside the exploratory subset".into(),
                ));
            }
            ";" => statement_tokens = 0,
            _ => {}
        }
        if statement_tokens > 128 {
            return Err(Error::Invalid("statement exceeds 128 tokens".into()));
        }
    }
    if depth != 0 {
        return Err(Error::Invalid("unbalanced OpenQASM delimiters".into()));
    }
    let parsed = SourceFile::parse_check_lex(source);
    if !parsed.have_parse() || !parsed.errors().is_empty() {
        return Err(Error::Invalid(format!(
            "OpenQASM parse errors: {:?}",
            parsed.errors()
        )));
    }
    let mut version = false;
    let mut include = false;
    let mut declaration = None;
    let mut operations = Vec::new();
    for statement in parsed.tree().statements() {
        let parts = tokens(&statement.syntax().text().to_string())?;
        match statement {
            Stmt::VersionString(_) if !version && declaration.is_none() && operations.is_empty() && !include => {
                if parts != ["OPENQASM", "3.0", ";"] { return Err(Error::Invalid("explicit OPENQASM 3.0; header required".into())); } version = true;
            },
            Stmt::Include(_) if version && !include && declaration.is_none() => {
                if parts != ["include", "\"stdgates.inc\"", ";"] { return Err(Error::Invalid("only the standard gate include is recognized; no files are read".into())); } include = true;
            },
            Stmt::QuantumDeclarationStatement(_) if version && declaration.is_none() => {
                let (name, count, array) = if parts.len() == 6 && parts[0] == "qubit" && parts[1] == "[" && parts[3] == "]" && parts[5] == ";" {
                    (parts[4].clone(), parts[2].parse::<u32>().map_err(|_| Error::Invalid("qubit count must be a decimal integer".into()))?, true)
                } else if parts.len() == 3 && parts[0] == "qubit" && parts[2] == ";" { (parts[1].clone(),1,false) }
                else { return Err(Error::Invalid("only one plain qubit register is supported".into())); };
                if !(1..=64).contains(&count) || !identifier(&name) { return Err(Error::Invalid("require 1–64 qubits and an ASCII register name".into())); }
                declaration = Some((name,count,array));
            },
            Stmt::ExprStmt(expr) if matches!(expr.expr(), Some(Expr::GateCallExpr(_))) => {
                let (name,count,array) = declaration.as_ref().ok_or_else(|| Error::Invalid("declare qubits before gates".into()))?;
                if operations.len() >= 4096 { return Err(Error::Invalid("circuit exceeds 4096 gates".into())); }
                let operation = gate(&parts, name, *count, *array)?;
                if operation.gate != "U" && !include { return Err(Error::Invalid("standard gates require include \"stdgates.inc\";".into())); }
                operations.push(operation);
            },
            _ => return Err(Error::Invalid("statement outside the static unitary subset (measurements, classical logic, barriers, modifiers and declarations are not lowered)".into())),
        }
    }
    let (register, qubits, _) =
        declaration.ok_or_else(|| Error::Invalid("missing qubit declaration".into()))?;
    if operations.is_empty() {
        return Err(Error::Invalid(
            "circuit needs at least one supported gate".into(),
        ));
    }
    let mut last = vec![None; qubits as usize];
    for (index, op) in operations.iter_mut().enumerate() {
        let previous: BTreeSet<_> = op.qubits.iter().filter_map(|q| last[*q as usize]).collect();
        op.predecessors = previous.into_iter().collect();
        for q in &op.qubits {
            last[*q as usize] = Some(index as u32);
        }
    }
    Ok(Circuit {
        source: source.into(),
        register,
        qubits,
        operations,
    })
}
