"""Publish a deterministic high-rate Gemba experiment burst to a local MQTT broker."""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

import paho.mqtt.client as mqtt

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "core" / "libs" / "python"))

from edgecommons.messaging.identity import HierEntry, MessageIdentity  # noqa: E402
from edgecommons.messaging.message_builder import MessageBuilder  # noqa: E402


IDENTITY = MessageIdentity(
    [HierEntry("device", "gemba-load")],
    "burst-source",
    "main",
)


def signal_envelope(value: int) -> bytes:
    return (
        MessageBuilder.create("SouthboundSignalUpdate", "1.0")
        .with_identity(IDENTITY)
        .with_southbound_signal_update({"samples": [{"value": value}]})
        .build()
        .to_bytes()
    )


def event_envelope(sequence: int) -> bytes:
    return (
        MessageBuilder.create("evt", "1.0")
        .with_identity(IDENTITY)
        .with_event({"sequence": sequence, "message": "x" * 4096})
        .build()
        .to_bytes()
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--signals", type=int, default=1500)
    parser.add_argument("--events", type=int, default=1200)
    parser.add_argument(
        "--signal-interval-ms",
        type=float,
        default=0.0,
        help="Pace signal publishes by this interval; zero preserves the original burst behavior.",
    )
    args = parser.parse_args()
    if args.signal_interval_ms < 0:
        parser.error("--signal-interval-ms must be non-negative")

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"gemba-burst-{uuid.uuid4()}",
    )
    client.connect("127.0.0.1", args.port, 30)
    client.loop_start()
    try:
        total = max(args.signals, args.events)
        last = None
        signal_interval = args.signal_interval_ms / 1000.0
        next_signal_at = time.perf_counter()
        for index in range(total):
            if index < args.signals:
                last = client.publish(
                    "ecv1/gemba-load/burst-source/main/data/speed",
                    signal_envelope(index),
                    qos=1,
                )
                if signal_interval > 0:
                    next_signal_at += signal_interval
                    remaining = next_signal_at - time.perf_counter()
                    if remaining > 0:
                        time.sleep(remaining)
            if index < args.events:
                last = client.publish(
                    "ecv1/gemba-load/burst-source/main/evt/high/gemba-burst",
                    event_envelope(index),
                    qos=1,
                )
        if last is not None:
            last.wait_for_publish(timeout=10)
    finally:
        client.disconnect()
        client.loop_stop()

    print(
        json.dumps(
            {
                "signals": args.signals,
                "events": args.events,
                "port": args.port,
                "signalIntervalMs": args.signal_interval_ms,
            }
        )
    )


if __name__ == "__main__":
    main()
