const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const app = express();
const PORT = 4000;

app.use(cors());
app.use(bodyParser.json());

const supabaseUrl = 'https://rtuavbaewkunkfpfygqs.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ0dWF2YmFld2t1bmtmcGZ5Z3FzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0Mjc0ODIsImV4cCI6MjA5NjAwMzQ4Mn0.aBj9A_XqVY1NljG3juAuYQQBXAsGDe7TmA5vCMAaPUM';
const supabase = createClient(supabaseUrl, supabaseKey);

// ⚠️ PEGA AQUÍ TU CLAVE DE OPENROUTER
const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
        'HTTP-Referer': 'http://localhost:4000',
        'X-Title': 'Case IA 360g'
    }
});

const TELEFONO_PRUEBA = '+59174632821'; 
let estadoUsuario = { paso_registro: 1, nombre_temp: '', rubro_temp: '', meta_temp: '' };

async function obtenerDatosCompletos(telefono) {
    try {
        const { data: usuario } = await supabase.from('usuarios').select('id, nombre_usuario, meta_ahorro_nombre').eq('telefono_whatsapp', telefono).single();
        if (!usuario) return null;

        const { data: transacciones } = await supabase.from('transacciones').select('tipo, monto_total_bs, bolsa_destino').eq('usuario_id', usuario.id);
        
        let saldoTotal = 0, capital = 0, gastoDiario = 0, ahorroMeta = 0;
        transacciones.forEach(t => {
            if (t.tipo === 'Ingreso') {
                saldoTotal += t.monto_total_bs;
                if (t.bolsa_destino === 'Capital_Reposicion') capital += t.monto_total_bs;
                else if (t.bolsa_destino === 'Ahorro_Meta') ahorroMeta += t.monto_total_bs;
            } else {
                saldoTotal -= t.monto_total_bs;
                if (t.bolsa_destino === 'Gasto_Diario') gastoDiario += t.monto_total_bs;
            }
        });

        const { count: totalProductos } = await supabase.from('productos').select('*', { count: 'exact', head: true }).eq('usuario_id', usuario.id);
        const { count: totalClientes } = await supabase.from('clientes').select('*', { count: 'exact', head: true }).eq('usuario_id', usuario.id);

        return {
            nombre: usuario.nombre_usuario,
            meta: usuario.meta_ahorro_nombre,
            saldo_total: saldoTotal,
            bolsas: { Capital_Reposicion: capital, Gasto_Diario: gastoDiario, Ahorro_Meta: ahorroMeta },
            metricas: { productos: totalProductos || 0, clientes: totalClientes || 0 }
        };
    } catch (error) {
        console.error("Error obteniendo datos:", error);
        return null;
    }
}

async function analizarConIA(mensaje, datosUsuario) {
    try {
        const nombre = datosUsuario?.nombre || 'amigo';
        const meta = datosUsuario?.meta || 'sus sueños';
        const saldo = datosUsuario?.saldo_total || 0;
        const capital = datosUsuario?.bolsas?.Capital_Reposicion || 0;
        const gasto = datosUsuario?.bolsas?.Gasto_Diario || 0;
        const ahorro = datosUsuario?.bolsas?.Ahorro_Meta || 0;
        const prod = datosUsuario?.metricas?.productos || 0;
        const cli = datosUsuario?.metricas?.clientes || 0;

        const completion = await openai.chat.completions.create({
            model: "qwen/qwen-2.5-72b-instruct",
            messages: [
                { 
                    role: "system", 
                    content: `Eres Case, asistente financiero ultra conciso para emprendedores en Bolivia.

DATOS REALES DEL USUARIO:
- Nombre: ${nombre} | Meta: ${meta}
- Saldo Total: ${saldo} Bs (Capital: ${capital} | Gasto: ${gasto} | Ahorro Meta: ${ahorro})
- Registro: ${prod} productos y ${cli} clientes en sistema.

REGLAS ESTRICTAS:
1. Respuestas de MÁXIMO 1 o 2 líneas.
2. Si piden "reporte", "resumen" o "números": da el desglose exacto en formato lista corta.
3. Si registran venta/compra: confirma con "✓ +X Bs a Capital" o "✓ -X Bs de Gasto".
4. Lenguaje boliviano directo: "Listo", "✓", "Ok", "Qué bueno".
5. Responde SOLO con JSON válido (sin markdown):
{"accion":"ingreso"|"gasto"|"reporte"|"consulta"|"otro", "monto":0, "respuesta":"texto ultra corto"}` 
                },
                { role: "user", content: mensaje }
            ],
            response_format: { type: "json_object" }
        });
        
        if (!completion?.choices?.[0]?.message?.content) throw new Error("Respuesta vacía");
        return JSON.parse(completion.choices[0].message.content);
    } catch (error) {
        console.error("Error Qwen:", error.message);
        return { accion: "error", monto: 0, respuesta: "Error. Repite el monto." };
    }
}

async function procesarMensajeCase(mensaje) {
    const { data: usuarioDB } = await supabase.from('usuarios').select('id, nombre_usuario, meta_ahorro_nombre').eq('telefono_whatsapp', TELEFONO_PRUEBA).single();

    if (!usuarioDB && estadoUsuario.paso_registro === 4) estadoUsuario = { paso_registro: 1, nombre_temp: '', rubro_temp: '', meta_temp: '' };
    if (usuarioDB) estadoUsuario.paso_registro = 4;

    if (estadoUsuario.paso_registro === 1) { estadoUsuario.nombre_temp = mensaje; estadoUsuario.paso_registro = 2; return `¿Cómo te llamas?`; }
    if (estadoUsuario.paso_registro === 2) { estadoUsuario.rubro_temp = mensaje; estadoUsuario.paso_registro = 3; return `¿Qué vendes?`; }
    if (estadoUsuario.paso_registro === 3) { 
        estadoUsuario.meta_temp = mensaje;
        await supabase.from('usuarios').insert([{ nombre_usuario: estadoUsuario.nombre_temp, telefono_whatsapp: TELEFONO_PRUEBA, rubro: 'Venta_Volumen', meta_ahorro_nombre: estadoUsuario.meta_temp }]);
        estadoUsuario.paso_registro = 4;
        return `✓ Cuenta creada. Meta: ${estadoUsuario.meta_temp}`;
    }

    const datos = await obtenerDatosCompletos(TELEFONO_PRUEBA) || { nombre: usuarioDB?.nombre_usuario, meta: usuarioDB?.meta_ahorro_nombre };
    const analisisIA = await analizarConIA(mensaje, datos);
    
    if (analisisIA.monto > 0) {
        const tipo = analisisIA.accion === 'ingreso' ? 'Ingreso' : 'Gasto_Material';
        const bolsa = analisisIA.accion === 'ingreso' ? 'Capital_Reposicion' : 'Gasto_Diario';
        await supabase.from('transacciones').insert([{ usuario_id: usuarioDB.id, tipo, monto_total_bs: analisisIA.monto, descripcion_transcrita_ia: mensaje, bolsa_destino: bolsa }]);
    }
    
    return analisisIA.respuesta;
}

app.post('/webhook/whatsapp', async (req, res) => {
    const msg = req.body.message || "";
    console.log(`📩 Recibido: "${msg}"`);
    const respuesta = await procesarMensajeCase(msg);
    console.log(`🤖 Case: "${respuesta}"\n`);
    res.json({ status: "success", reply: respuesta });
});

app.listen(PORT, () => console.log(`\n✅ Case IA + Audio + Borrar activado en http://localhost:${PORT}\n`));

app.get('/test', (req, res) => res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Case IA - 360g</title>
    <style>
        body { margin: 0; font-family: Helvetica, Arial, sans-serif; background-color: #e5ddd5; display: flex; justify-content: center; height: 100vh; }
        .chat-container { width: 100%; max-width: 450px; background: #fff; display: flex; flex-direction: column; height: 100%; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
        .header { background: #075e54; color: white; padding: 15px; display: flex; align-items: center; gap: 10px; }
        .avatar { width: 40px; height: 40px; background: #128c7e; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; }
        .chat-area { flex: 1; padding: 15px; overflow-y: auto; background-image: url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png'); background-color: #e5ddd5; }
        .message { max-width: 75%; padding: 8px 12px; border-radius: 8px; margin-bottom: 10px; font-size: 14px; line-height: 1.4; position: relative; word-wrap: break-word; }
        .message.case { background: #fff; align-self: flex-start; border-top-left-radius: 0; box-shadow: 0 1px 1px rgba(0,0,0,0.1); }
        .message.user { background: #dcf8c6; align-self: flex-end; margin-left: auto; border-top-right-radius: 0; box-shadow: 0 1px 1px rgba(0,0,0,0.1); }
        .time { font-size: 10px; color: #999; text-align: right; margin-top: 4px; }
        .input-area { background: #f0f0f0; padding: 10px; display: flex; gap: 10px; align-items: center; }
        .input-area input { flex: 1; padding: 10px; border: none; border-radius: 20px; outline: none; font-size: 15px; }
        .mic-btn { background: #128c7e; color: white; border: none; width: 45px; height: 45px; border-radius: 50%; cursor: pointer; font-size: 20px; display: flex; align-items: center; justify-content: center; user-select: none; transition: all 0.2s; }
        .mic-btn:active { background: #075e54; transform: scale(0.95); }
        .mic-btn.recording { background: #dc3545; animation: pulse 1s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(220, 53, 69, 0.7); } 70% { box-shadow: 0 0 0 15px rgba(220, 53, 69, 0); } 100% { box-shadow: 0 0 0 0 rgba(220, 53, 69, 0); } }
        .send-btn { background: #128c7e; color: white; border: none; width: 45px; height: 45px; border-radius: 50%; cursor: pointer; font-size: 18px; }
        .suggestions { padding: 10px; background: #f0f0f0; display: flex; gap: 8px; overflow-x: auto; }
        .chip { background: #fff; border: 1px solid #128c7e; color: #128c7e; padding: 6px 12px; border-radius: 15px; font-size: 12px; cursor: pointer; white-space: nowrap; }
        .recording-bar { background: #fff3cd; color: #856404; padding: 8px; display: none; align-items: center; justify-content: space-between; font-size: 13px; }
        .recording-bar.show { display: flex; }
        .cancel-btn { background: #dc3545; color: white; border: none; padding: 4px 10px; border-radius: 12px; cursor: pointer; font-size: 12px; font-weight: bold; }
        
        /* Botón de borrar mensaje */
        .delete-btn {
            position: absolute; top: -6px; right: -6px; background: #fff; border: 1px solid #ddd;
            border-radius: 50%; width: 22px; height: 22px; font-size: 12px; display: flex;
            align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            opacity: 0; transition: opacity 0.2s; z-index: 10;
        }
        .message:hover .delete-btn { opacity: 1; }
        @media (hover: none) { .delete-btn { opacity: 0.8; } } /* Visible en celular */
    </style>
</head>
<body>
    <div class="chat-container">
        <div class="header">
            <div class="avatar">C</div>
            <div><strong>Case IA</strong><br><small style="color:#d1f0e8">En línea</small></div>
        </div>
        <div class="suggestions">
            <div class="chip" onclick="send('vendí 150 bs')">Vendí 150 bs</div>
            <div class="chip" onclick="send('gaste 30 en pasajes')">Gasté 30 bs</div>
            <div class="chip" onclick="send('dame un reporte semanal')">Reporte semanal</div>
            <div class="chip" onclick="send('¿cuánto tengo?')">¿Cuánto tengo?</div>
        </div>
        <div class="chat-area" id="chat"></div>
        
        <!-- Barra de cancelación de audio -->
        <div class="recording-bar" id="recordingBar">
            <span>🎤 Grabando... <span id="transcriptPreview"></span></span>
            <button class="cancel-btn" onclick="cancelRecording()">❌ Cancelar</button>
        </div>

        <div class="input-area">
            <input type="text" id="msg" placeholder="Escribe un mensaje..." onkeypress="if(event.key==='Enter') sendMsg()">
            <button class="mic-btn" id="micBtn" onmousedown="startRecording()" onmouseup="stopRecording()" onmouseleave="stopRecording()" ontouchstart="startRecording()" ontouchend="stopRecording()">🎤</button>
            <button class="send-btn" onclick="sendMsg()">➤</button>
        </div>
    </div>
    <script>
        let recognition;
        let isRecording = false;
        let finalTranscript = '';

        if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            recognition = new SpeechRecognition();
            recognition.lang = 'es-BO';
            recognition.continuous = false;
            recognition.interimResults = true;

            recognition.onresult = (event) => {
                let interimTranscript = '';
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const transcript = event.results[i][0].transcript;
                    if (event.results[i].isFinal) {
                        finalTranscript += transcript;
                    } else {
                        interimTranscript += transcript;
                    }
                }
                document.getElementById('transcriptPreview').innerText = finalTranscript + interimTranscript;
            };

            recognition.onerror = (event) => {
                console.error('Error de reconocimiento:', event.error);
                cancelRecording();
            };

            recognition.onend = () => {
                if (isRecording && finalTranscript) {
                    send(finalTranscript.trim());
                    finalTranscript = '';
                }
                stopRecordingUI();
            };
        }

        function startRecording() {
            if (!recognition) { alert('Usa Chrome o Edge para usar el micrófono.'); return; }
            if (isRecording) return;
            isRecording = true;
            finalTranscript = '';
            recognition.start();
            
            document.getElementById('micBtn').classList.add('recording');
            document.getElementById('micBtn').innerHTML = '⏹';
            document.getElementById('recordingBar').classList.add('show');
            document.getElementById('transcriptPreview').innerText = 'Escuchando...';
        }

        function stopRecording() {
            if (!isRecording) return;
            isRecording = false;
            if (recognition) recognition.stop();
        }

        function cancelRecording() {
            isRecording = false;
            finalTranscript = '';
            if (recognition) recognition.abort();
            stopRecordingUI();
        }

        function stopRecordingUI() {
            document.getElementById('micBtn').classList.remove('recording');
            document.getElementById('micBtn').innerHTML = '🎤';
            document.getElementById('recordingBar').classList.remove('show');
        }

        function getTime() { return new Date().toLocaleTimeString('es-BO', {hour: '2-digit', minute:'2-digit'}); }
        
        function addMessage(text, sender) {
            const chat = document.getElementById('chat');
            const div = document.createElement('div');
            div.className = 'message ' + sender;
            
            // Botón de borrar
            const delBtn = document.createElement('div');
            delBtn.className = 'delete-btn';
            delBtn.innerHTML = '🗑️';
            delBtn.onclick = function() {
                div.innerHTML = '<em style="color:#888; font-size:12px;">🚫 Mensaje eliminado</em><div class="time">' + getTime() + '</div>';
            };
            div.appendChild(delBtn);
            
            const textSpan = document.createElement('span');
            textSpan.innerText = text;
            div.appendChild(textSpan);
            
            const timeDiv = document.createElement('div');
            timeDiv.className = 'time';
            timeDiv.innerText = getTime() + (sender === 'user' ? ' ✓✓' : '');
            div.appendChild(timeDiv);
            
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
        }

        function send(text) {
            document.getElementById('msg').value = text;
            sendMsg();
        }

        function sendMsg() {
            const input = document.getElementById('msg');
            const text = input.value.trim();
            if (!text) return;
            addMessage(text, 'user');
            input.value = '';
            addMessage('Escribiendo...', 'case');
            
            fetch('/webhook/whatsapp', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ message: text })
            }).then(r => r.json()).then(d => {
                const lastMsg = document.querySelector('.chat-area .message.case:last-child');
                // Reemplazar "Escribiendo..." con la respuesta real
                lastMsg.innerHTML = '<div class="delete-btn">🗑️</div><span>' + d.reply + '</span><div class="time">' + getTime() + '</div>';
                // Re-asignar evento de borrar al nuevo botón
                lastMsg.querySelector('.delete-btn').onclick = function() {
                    lastMsg.innerHTML = '<em style="color:#888; font-size:12px;">🚫 Mensaje eliminado</em><div class="time">' + getTime() + '</div>';
                };
            }).catch(() => {
                const lastMsg = document.querySelector('.chat-area .message.case:last-child');
                lastMsg.innerHTML = '<span>Error de conexión.</span><div class="time">' + getTime() + '</div>';
            });
        }
        setTimeout(() => addMessage('¡Hola! Soy Case. Mantén presionado 🎤 para hablar, o usa ❌ para cancelar antes de enviar.', 'case'), 500);
    </script>
</body>
</html>
`));