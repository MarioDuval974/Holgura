# Holgura

Llega a fin de mes con margen y ahorra sin agobios.

Holgura es una app web (PWA) de finanzas personales pensada para el móvil:

- **Tu mes de un vistazo:** nómina, gastos fijos (en total o gasto a gasto) y lo que te sobra.
- **Ahorro recomendado:** aprende lo que gastas en el día a día y te dice cuánto puedes ahorrar sin llegar justo.
- **Revisiones periódicas:** escribes el saldo de tu cuenta y te dice si vas bien 🟢, si debes ajustar 🟡 o si tendrás que tirar de la hucha 🔴.
- **Huchas:** tantas como quieras, con ingresos, retiradas y objetivos.

🔒 Tus datos (presupuesto, huchas, revisiones) se guardan solo en tu móvil. Este repositorio contiene únicamente el código de la app.

Si conectas tu banco (opcional), el servidor de Holgura guarda cifrado el permiso de lectura: el banco, la fecha de caducidad y tus cuentas con el IBAN parcialmente oculto. El saldo y los movimientos pasan por el servidor cuando la app los pide, pero no se guardan allí. Desconectar el banco borra ese permiso.

## Instalar en el iPhone

1. Abre el enlace de la app en **Safari**.
2. Pulsa el botón **Compartir** (el cuadrado con la flecha hacia arriba).
3. Elige **«Añadir a pantalla de inicio»** y pulsa **Añadir**.

A partir de ahí se abre desde su icono a pantalla completa y funciona sin conexión.

## Copia de seguridad

En **Mi mes → Tus datos** puedes exportar una copia (un archivo `.json`) e importarla en otro móvil. Si borras la app o los datos de Safari, los datos se pierden, así que exporta una copia de vez en cuando.
