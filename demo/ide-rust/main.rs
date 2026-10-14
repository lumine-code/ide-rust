fn average(samples: &[f64]) -> f64 {
    samples.iter().sum::<f64>() / samples.len() as f64
}

fn main() {
    let samples = [0.2, 0.8, -0.4, 0.5, 1.0];
    let amplitude: f64 = "high";
    println!("{} {}", average(&samples), amplitude);
}
