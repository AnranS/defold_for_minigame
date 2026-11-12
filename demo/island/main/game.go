components {
  id: "game"
  component: "/main/game.script"
}
components {
  id: "hud"
  component: "/main/hud.gui"
}
embedded_components {
  id: "bgm"
  type: "sound"
  data: "sound: \"/assets/audio/bgm.wav\"\nlooping: 1\ngain: 0.5\n"
}
embedded_components {
  id: "solid_factory"
  type: "factory"
  data: "prototype: \"/world/solid.go\"\n"
}
embedded_components {
  id: "water_factory"
  type: "factory"
  data: "prototype: \"/world/water.go\"\n"
}
embedded_components {
  id: "fx_factory"
  type: "factory"
  data: "prototype: \"/world/fx.go\"\n"
}
