#version 140

in mediump vec4 var_color;
in mediump float var_fog;

out vec4 out_fragColor;

uniform fs_uniforms
{
    mediump vec4 fog_color;
    mediump vec4 grade;
};

void main()
{
    mediump vec3 c = mix(var_color.rgb, fog_color.rgb, var_fog);
    mediump float luma = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(luma), c, grade.a) * grade.rgb;
    out_fragColor = vec4(c * var_color.a, var_color.a);
}
