components {
  id: "gui"
  component: "/example/apitest.gui"
}
components {
  id: "driver"
  component: "/example/apitest.script"
}
embedded_components {
  id: "tone"
  type: "sound"
  data: "sound: \"/example/assets/tone.wav\"\n"
  ""
}
