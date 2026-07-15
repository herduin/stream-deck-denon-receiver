# Control de Receptor Denon para Stream Deck

Un plugin de Stream Deck que permite el control por red de receptores Denon/Marantz y parlantes con soporte HEOS.

## Características

- **Control de Volumen**: Muestra y ajusta niveles de volumen, con funcionalidad de silenciar/reactivar
  - Funciona tanto con botones estándar de Stream Deck como con diales de Stream Deck+
  - Muestra el nivel de volumen en tiempo real en los diales
  - Retroalimentación visual para el estado de silencio

- **Control de Encendido**: Enciende/apaga tu receptor con retroalimentación visual del estado

- **Selección de Fuente de Entrada**: Acceso rápido para cambiar entre fuentes de entrada
  - Soporta fuentes de entrada estándar de Denon/Marantz

- **Soporte Multi-Zona**: Controla la Zona Principal y Zona 2 de forma independiente para acciones que soportan zonas

## Requisitos

- Stream Deck Software 6.4 o posterior
- macOS 10.15 o posterior
- Windows 10 o posterior
- Receptor o parlante Denon/Marantz con soporte HEOS (ej: Denon Home 200)
- El dispositivo debe estar en la misma red que tu computadora

## Instalación

### Descargar e instalar localmente
1. Descarga la última versión desde -> [aquí](https://github.com/herduin/stream-deck-denon-receiver/releases/latest) <-
2. Haz doble clic en el archivo descargado para instalar
3. El software de Stream Deck instalará automáticamente el plugin

### Desde GitHub Actions
1. Ve a la pestaña [Actions](https://github.com/herduin/stream-deck-denon-receiver/actions) del repositorio
2. Selecciona la última ejecución exitosa del workflow "Build Stream Deck Plugin"
3. Descarga el artefacto `stream-deck-plugin`
4. Descomprime y haz doble clic en el archivo `.streamDeckPlugin` para instalar

## Uso

1. Agrega cualquiera de las acciones de control del receptor a tu Stream Deck
2. Al configurar una acción por primera vez:
   - El plugin buscará automáticamente receptores compatibles en tu red
   - Selecciona tu receptor de la lista desplegable
   - Elige la zona que deseas controlar
   - Configura los ajustes específicos de la acción

### Acciones Disponibles

#### Control de Volumen
- Usa como botón para alternar silencio o establecer niveles específicos de volumen
- En Stream Deck+:
  - Gira el dial para ajustar el volumen
  - Presiona/toca para alternar silencio
  - Muestra el nivel de volumen actual en la pantalla del dial

#### Control de Volumen Dinámico
- Disponible como botón para alternar entre cada estado
- Muestra el estado actual de la función desde el receptor

#### Control de Encendido
- Alternar estado de encendido
- Establecer explícitamente encendido o apagado
- La retroalimentación visual muestra el estado actual de encendido

#### Control de Fuente de Entrada
- Selección rápida de fuentes de entrada

## Desarrollo

Este plugin está construido usando:
- Node.js 20
- Stream Deck SDK v2
- Módulo @elgato/streamdeck para Node.js

Para compilar desde el código fuente:

```
npm install
npm run build
```

Para desarrollo con recarga automática:

```
npm install
npm run watch
```

## Solución de Problemas

Si tu receptor no es detectado:
1. Asegúrate de que tu receptor tenga soporte HEOS habilitado (no necesitas estar conectado a HEOS)
2. Verifica que tu receptor esté en el mismo segmento de red LAN que tu computadora
3. Comprueba que ningún firewall esté bloqueando el descubrimiento de red
4. Intenta actualizar la lista de receptores en la configuración de la acción

## Conexión

El plugin soporta dos modos de conexión:
- **Telnet** (puerto 23): Conexión en tiempo real con eventos instantáneos. Usado en receptores AVR tradicionales.
- **HTTP API** (puerto 80): Modo de respaldo con polling cada 5 segundos. Se activa automáticamente cuando Telnet no está disponible (común en dispositivos HEOS como el Denon Home 200).

## Créditos

- [mthiel](https://github.com/mthiel) — Autor original del plugin
- [herduin](https://github.com/herduin) — Soporte HTTP fallback para dispositivos HEOS (Denon Home 200), corrección de errores de conexión, actualización del workflow de build
