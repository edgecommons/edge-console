(function () {
  "use strict";

  var start = Date.now();
  var bottles = 58742;
  var rejects = 412;
  var pressureAlert = false;
  var history = [];
  var board = document.querySelector(".board");
  var button = document.getElementById("scenario-button");

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function drawTrend(values) {
    var width = 760;
    var height = 158;
    var low = 96;
    var high = 146;
    var line = "";
    var i;
    for (i = 0; i < values.length; i += 1) {
      var x = values.length === 1 ? 0 : (i / (values.length - 1)) * width;
      var y = height - ((values[i] - low) / (high - low)) * height;
      line += (i === 0 ? "M" : " L") + x.toFixed(1) + " " + y.toFixed(1);
    }
    document.getElementById("pressure-line").setAttribute("d", line);
    document.getElementById("pressure-area").setAttribute("d", line + " L" + width + " " + height + " L0 " + height + " Z");
  }

  function tick() {
    var elapsed = (Date.now() - start) / 1000;
    var speed = pressureAlert ? 114 + Math.sin(elapsed / 2) * 2 : 126 + Math.sin(elapsed / 4) * 1.8;
    var pressure = pressureAlert ? 140.4 + Math.sin(elapsed * 1.7) * 2.2 : 112.4 + Math.sin(elapsed / 2.6) * 3.1 + Math.sin(elapsed * 1.3) * 0.8;
    var fill = (pressureAlert ? 502.1 : 500.2) + Math.sin(elapsed / 3.1) * 0.48;
    var temperature = 4.3 + Math.sin(elapsed / 17) * 0.18;
    var bowl = 78 + Math.sin(elapsed / 7.5) * 1.2;

    bottles += speed / 120;
    if (Math.floor(elapsed) > 0 && Math.floor(elapsed) % 19 === 0 && elapsed % 1 < 0.55) rejects += 1;
    history.push(pressure);
    if (history.length > 62) history.shift();

    setText("clock", new Date().toLocaleTimeString([], { hour12: false }));
    setText("bpm", Math.round(speed));
    setText("pressure", pressure.toFixed(1));
    setText("pressure-sigma", pressureAlert ? "6.4" : "2.8");
    setText("fill-volume", fill.toFixed(1));
    setText("temperature", temperature.toFixed(1));
    setText("bowl-level", Math.round(bowl));
    setText("bottle-count", Math.floor(bottles).toLocaleString());
    setText("reject-count", rejects.toLocaleString());
    setText("underfill-rate", pressureAlert ? "0.72%" : "0.18%");
    document.getElementById("bottle-liquid").style.height = clamp(77 + (fill - 500) * 2.2, 70, 88).toFixed(1) + "%";
    drawTrend(history);
  }

  function toggleScenario() {
    pressureAlert = !pressureAlert;
    board.classList.toggle("is-pressure-alert", pressureAlert);
    button.setAttribute("aria-pressed", String(pressureAlert));
    document.getElementById("line-state").textContent = pressureAlert ? "Pressure drift" : "Running steady";
    document.getElementById("attention-text").textContent = pressureAlert
      ? "Fill pressure above 140 kPa · verify bowl regulator"
      : "Capper bowl trending 3% above normal vibration";
  }

  button.addEventListener("click", toggleScenario);
  document.addEventListener("keydown", function (event) {
    if (event.key === "a" || event.key === "A") toggleScenario();
  });
  tick();
  window.setInterval(tick, 500);
}());
