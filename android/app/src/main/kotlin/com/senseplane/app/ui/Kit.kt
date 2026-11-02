// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
package com.senseplane.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object Ink {
    val bg = Color(0xFF0A0A0B)
    val panel = Color(0xFF111113)
    val raise = Color(0xFF151518)
    val line = Color(0xFF1F1F23)
    val edge = Color(0xFF2E2E33)
    val text = Color(0xFFEDEDEF)
    val soft = Color(0xFFC9C9CE)
    val muted = Color(0xFF9A9AA2)
    val live = Color(0xFF2DD4E8)
    val warn = Color(0xFFF5B544)
}

@Composable
fun SenseplaneTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            background = Ink.bg, surface = Ink.panel, primary = Ink.live, onPrimary = Ink.bg,
            onBackground = Ink.text, onSurface = Ink.text, outline = Ink.edge,
        ),
        content = content,
    )
}

val mono = FontFamily.Monospace

/** A full screen: optional back arrow and title, scrolling content, and actions pinned at the bottom. */
@Composable
fun Screen(
    title: String? = null,
    onBack: (() -> Unit)? = null,
    scroll: Boolean = true,
    bottom: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize().background(Ink.bg).statusBarsPadding().navigationBarsPadding().imePadding()) {
        if (title != null || onBack != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (onBack != null) {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = Ink.soft) }
                } else Spacer(Modifier.width(12.dp))
                if (title != null) Text(title, color = Ink.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().let { if (scroll) it.verticalScroll(rememberScrollState()) else it }.padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
            content = content,
        )
        if (bottom != null) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = bottom)
        }
    }
}

@Composable
fun Label(text: String) = Text(text.uppercase(), color = Ink.muted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.7.sp)

@Composable
fun Body(text: String, color: Color = Ink.soft, size: Int = 14) = Text(text, color = color, fontSize = size.sp, lineHeight = (size * 1.5).sp)

@Composable
fun Primary(text: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) = Button(
    onClick = onClick, enabled = enabled, shape = RoundedCornerShape(10.dp),
    colors = ButtonDefaults.buttonColors(containerColor = Ink.live, contentColor = Ink.bg, disabledContainerColor = Ink.edge, disabledContentColor = Ink.muted),
    modifier = modifier.fillMaxWidth().heightIn(min = 50.dp),
) { Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold) }

@Composable
fun Secondary(text: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) = OutlinedButton(
    onClick = onClick, enabled = enabled, shape = RoundedCornerShape(10.dp), border = BorderStroke(1.dp, Ink.edge),
    colors = ButtonDefaults.outlinedButtonColors(contentColor = Ink.text),
    modifier = modifier.fillMaxWidth().heightIn(min = 48.dp),
) { Text(text, fontSize = 15.sp, fontWeight = FontWeight.Medium) }

/** A panel of rows. */
@Composable
fun Panel(content: @Composable ColumnScope.() -> Unit) = Column(
    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Ink.panel).border(1.dp, Ink.line, RoundedCornerShape(12.dp)),
    content = content,
)

/** A tappable row: title, a line under it, and an arrow. */
@Composable
fun NavRow(title: String, sub: String? = null, subColor: Color = Ink.muted, dot: Color? = null, onClick: () -> Unit) = Row(
    Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 12.dp, vertical = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(title, color = Ink.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        if (sub != null) Row(verticalAlignment = Alignment.CenterVertically) {
            if (dot != null) { Dot(dot); Spacer(Modifier.width(6.dp)) }
            Text(sub, color = subColor, fontSize = 13.sp)
        }
    }
    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = Color(0xFF7C7C85))
}

@Composable
fun ToggleRow(title: String, sub: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) = Row(
    Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 12.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, color = Ink.text, fontSize = 15.sp)
        if (sub != null) Text(sub, color = Ink.muted, fontSize = 12.sp)
    }
    Switch(
        checked = checked, enabled = enabled, onCheckedChange = onChange,
        colors = SwitchDefaults.colors(checkedTrackColor = Ink.live, checkedThumbColor = Ink.bg, uncheckedTrackColor = Ink.edge, uncheckedThumbColor = Ink.soft, uncheckedBorderColor = Ink.edge),
    )
}

@Composable
fun Divider() = Box(Modifier.fillMaxWidth().height(1.dp).background(Ink.line))

@Composable
fun Dot(color: Color, size: Int = 8) = Box(Modifier.size(size.dp).clip(CircleShape).background(color))

@Composable
fun Field(label: String, value: String, onChange: (String) -> Unit, placeholder: String = "", password: Boolean = false, monoFont: Boolean = false, keyboard: KeyboardType = KeyboardType.Text, hint: String? = null, error: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
            value = value, onValueChange = onChange, singleLine = true,
            label = { Text(label) },
            placeholder = { Text(placeholder, color = Color(0xFF8A8A93)) },
            visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboard),
            textStyle = TextStyle(color = Ink.text, fontSize = 15.sp, fontFamily = if (monoFont) mono else FontFamily.Default),
            isError = error != null,
            shape = RoundedCornerShape(10.dp),
            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Ink.live, unfocusedBorderColor = Ink.edge, focusedLabelColor = Ink.live, unfocusedLabelColor = Ink.soft, focusedContainerColor = Ink.panel, unfocusedContainerColor = Ink.panel),
            modifier = Modifier.fillMaxWidth(),
        )
        if (error != null) Text(error, color = Ink.warn, fontSize = 12.sp)
        else if (hint != null) Text(hint, color = Ink.muted, fontSize = 12.sp, lineHeight = 18.sp)
    }
}

/** A numbered step with its text. */
@Composable
fun Step(n: Int, text: String) = Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
    Box(Modifier.size(24.dp).clip(CircleShape).background(Color(0xFF1C1C20)), contentAlignment = Alignment.Center) { Text("$n", color = Ink.soft, fontSize = 13.sp) }
    Body(text)
}

@Composable
fun StatusLine(text: String, color: Color) = Row(
    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Ink.panel).border(1.dp, Ink.line, RoundedCornerShape(10.dp)).padding(12.dp),
    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
) {
    Dot(color)
    Text(text, color = Ink.soft, fontSize = 14.sp)
}

@Composable
fun RowScope.Spring() = Spacer(Modifier.weight(1f))
