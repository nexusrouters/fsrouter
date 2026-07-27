async function a(){return(await(await fetch("/api/health")).json()).machineId??"browser"}async function e(){return await a()}export{e as g};
