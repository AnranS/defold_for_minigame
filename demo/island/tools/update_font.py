#!/usr/bin/env python3
"""Writes the characters the game shows into assets/fonts/ui.font.

Defold builds a glyph for every character listed in a font file and nothing
else, so the list has to follow the text in the scripts. Run this after
changing any text; it fails when the font has no glyph for a character.
"""
import pathlib, re, struct, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONT = ROOT / "assets/fonts/ZCOOLKuaiLe-Regular.ttf"
TARGET = ROOT / "assets/fonts/ui.font"
SOURCES = [*ROOT.glob("island/*.lua"), *ROOT.glob("main/*.script"), *ROOT.glob("main/*.gui_script")]


def covered(font_path):
    """Code points the font maps to a glyph (cmap formats 4 and 12)."""
    data = font_path.read_bytes()
    tables = struct.unpack(">H", data[4:6])[0]
    cmap = None
    for i in range(tables):
        tag, _, offset, _ = struct.unpack(">4sIII", data[12 + i * 16: 28 + i * 16])
        if tag == b"cmap":
            cmap = offset
    points = set()
    count = struct.unpack(">H", data[cmap + 2: cmap + 4])[0]
    for i in range(count):
        _, _, sub = struct.unpack(">HHI", data[cmap + 4 + i * 8: cmap + 12 + i * 8])
        at = cmap + sub
        kind = struct.unpack(">H", data[at: at + 2])[0]
        if kind == 4:
            segs = struct.unpack(">H", data[at + 6: at + 8])[0] // 2
            ends = struct.unpack(f">{segs}H", data[at + 14: at + 14 + segs * 2])
            starts = struct.unpack(f">{segs}H", data[at + 16 + segs * 2: at + 16 + segs * 4])
            deltas = struct.unpack(f">{segs}h", data[at + 16 + segs * 4: at + 16 + segs * 6])
            offsets_at = at + 16 + segs * 6
            offsets = struct.unpack(f">{segs}H", data[offsets_at: offsets_at + segs * 2])
            for s in range(segs):
                for code in range(starts[s], ends[s] + 1):
                    if code == 0xFFFF:
                        continue
                    if offsets[s] == 0:
                        glyph = (code + deltas[s]) & 0xFFFF
                    else:
                        where = offsets_at + s * 2 + offsets[s] + (code - starts[s]) * 2
                        glyph = struct.unpack(">H", data[where: where + 2])[0]
                    if glyph:
                        points.add(code)
        elif kind == 12:
            groups = struct.unpack(">I", data[at + 12: at + 16])[0]
            for g in range(groups):
                start, end, _ = struct.unpack(">III", data[at + 16 + g * 12: at + 28 + g * 12])
                points.update(range(start, end + 1))
    return points


def main():
    # Only text inside string literals is shown; comments may use any character.
    used = set()
    for source in SOURCES:
        for literal in re.findall(r'"((?:[^"\\\n]|\\.)*)"', source.read_text(encoding="utf-8")):
            for char in literal:
                if ord(char) > 126 and not char.isspace():
                    used.add(char)
    have = covered(FONT)
    missing = sorted(char for char in used if ord(char) not in have)
    if missing:
        sys.exit("the font has no glyph for: " + " ".join(missing))
    ascii_part = "".join(chr(code) for code in range(32, 127))
    characters = ascii_part + "".join(sorted(used))
    escaped = characters.replace("\\", "\\\\").replace('"', '\\"')
    lines = TARGET.read_text(encoding="utf-8").splitlines()
    lines = [line for line in lines if not line.startswith("characters:")]
    lines.append(f'characters: "{escaped}"')
    TARGET.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(used)} characters beyond ASCII written to {TARGET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
