/**
 * Web Resource: Clonar Campaña Analítica y sus registros relacionados
 * Contexto: Botón de comando en la vista (Home Grid) de tema_litogl_tp_campaniasanalitica
 * Requisitos cubiertos:
 *  - Solo se ejecuta con una selección en el grid
 *  - Crea una nueva campaña copiando campos válidos
 *  - Duplica todos los registros 1:N relacionados y re-vincula al nuevo registro
 *  - Implementación genérica basada en metadatos de Dataverse
 */

(function(){
  'use strict';

  var ENTITY_CAMPAÑA = 'tema_litogl_tp_campaniasanalitica';
  // Configuración específica del proyecto
  var CONFIG = {
    // Forzar clonación solo de estas entidades hijas 1:N
    childWhitelist: {
      'tema_litoglcampanaequipo': true,
      'tema_litoglcampanapaquetes': true
    }
  };

  // API utilitario
  var Api = {
    showProgress: function(msg){ try{ if(window.Xrm && Xrm.Utility && Xrm.Utility.showProgressIndicator){ Xrm.Utility.showProgressIndicator(msg||'Procesando...'); } }catch(e){} },
    hideProgress: function(){ try{ if(window.Xrm && Xrm.Utility && Xrm.Utility.closeProgressIndicator){ Xrm.Utility.closeProgressIndicator(); } }catch(e){} },
    alert: function(text){ try{ if(Xrm && Xrm.Navigation && Xrm.Navigation.openAlertDialog){ Xrm.Navigation.openAlertDialog({ text: text }); } else { alert(text); } }catch(e){ try{ alert(text); }catch(_){} } },
    confirm: function(text){ return new Promise(function(resolve){ try{ if(Xrm && Xrm.Navigation && Xrm.Navigation.openConfirmDialog){ Xrm.Navigation.openConfirmDialog({ text: text }).then(function(r){ resolve(!!(r && r.confirmed)); }); } else { resolve(window.confirm(text)); } }catch(e){ resolve(window.confirm(text)); } }); },
    stripGuid: function(g){ return (g||'').replace(/[{}]/g,'').toLowerCase(); },
    refreshGrid: function(primaryControl){
      try{
        if(primaryControl && primaryControl.getGrid && primaryControl.getGrid().refresh){
          primaryControl.getGrid().refresh();
          return;
        }
      }catch(e){}
      try{
        if(Xrm && Xrm.App && Xrm.App.refreshParentGrid){ Xrm.App.refreshParentGrid(); }
      }catch(e){}
    }
  };

  // GET crudo al Web API (útil para metadatos como EntityDefinitions)
  function webApiGet(path){
    var base = (Xrm && Xrm.Utility && Xrm.Utility.getGlobalContext) ? Xrm.Utility.getGlobalContext().getClientUrl() : window.location.origin;
    var url = base + '/api/data/v9.2' + path;
    return fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        'Prefer': 'odata.include-annotations="*"'
      },
      credentials: 'same-origin'
    }).then(function(resp){
      if(!resp.ok){
        return resp.text().then(function(t){
          throw new Error('Web API '+resp.status+': '+t);
        });
      }
      return resp.json();
    });
  }

  // Cachés de metadatos para minimizar llamadas
  var MetadataCache = {
    entity: {}, // logicalName -> { entitySetName, attributes: [...], manyToOne: [...], oneToMany: [...] }
    targetSetName: {} // logicalName -> entitySetName
  };

  function getEntityDefinition(logicalName){
    if(MetadataCache.entity[logicalName]) return Promise.resolve(MetadataCache.entity[logicalName]);

    var q = "?$filter=LogicalName eq '"+logicalName+"'&$select=LogicalName,EntitySetName&"+
            "$expand="+
            "Attributes($select=LogicalName,IsPrimaryId,IsValidForCreate,IsValidForUpdate,AttributeType,IsLogical),"+
            "ManyToOneRelationships($select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName),"+
            "OneToManyRelationships($select=ReferencingEntity,ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName)";
    return webApiGet('/EntityDefinitions' + q).then(function(res){
      var def = res && (res.value ? res.value[0] : res);
      if(!def) throw new Error('No se encontró metadata para '+logicalName);
      var allAttrs = def.Attributes || [];
      var primaryIdAttr = null;
      for(var i=0;i<allAttrs.length;i++){ if(allAttrs[i].IsPrimaryId){ primaryIdAttr = allAttrs[i].LogicalName; break; } }
      var out = {
        entitySetName: def.EntitySetName,
        attributes: allAttrs.filter(function(a){ return !a.IsPrimaryId && !a.IsLogical; }),
        manyToOne: def.ManyToOneRelationships || [],
        oneToMany: def.OneToManyRelationships || [],
        primaryIdAttr: primaryIdAttr
      };
      MetadataCache.entity[logicalName] = out;
      MetadataCache.targetSetName[logicalName] = def.EntitySetName;
      return out;
    });
  }

  function getTargetSetName(targetLogicalName){
    if(MetadataCache.targetSetName[targetLogicalName]) return Promise.resolve(MetadataCache.targetSetName[targetLogicalName]);
    var q = "?$filter=LogicalName eq '"+targetLogicalName+"'&$select=EntitySetName";
    return webApiGet('/EntityDefinitions' + q).then(function(res){
      var def = res && res.value && res.value[0];
      if(!def) throw new Error('No se encontró EntitySetName para '+targetLogicalName);
      MetadataCache.targetSetName[targetLogicalName] = def.EntitySetName;
      return def.EntitySetName;
    });
  }

  // Construye lista de campos seleccionables para retrieveRecord
  function buildSelectList(attributes, extra){
    var selectables = attributes.filter(function(a){ return a.IsValidForCreate || a.IsValidForUpdate; })
      .map(function(a){ return a.LogicalName; });
    // Evitar campos de estado que puedan bloquear creación
    var skip = {
      statecode: true,
      statuscode: true,
      // Evitar copiar propietarios por ambigüedad (usuario/equipo) y propiedades auxiliares
      ownerid: true,
      owneridtype: true,
      owningbusinessunit: true,
      createdby: true,
      createdbyname: true,
      createdon: true,
      createdbytype: true,
      modifiedby: true,
      modifiedbyname: true,
      modifiedon: true,
      modifiedbytype: true
    };
    var finalList = selectables.filter(function(n){ return !skip[n]; });
    if(Array.isArray(extra) && extra.length){ finalList = finalList.concat(extra); }
    return finalList.join(',');
  }

  // Convierte un registro recuperado en payload de creación, preservando lookups y valores simples
  function buildCreatePayload(entityLogicalName, def, record){
    var payload = {};
    var attrs = def.attributes;
    var m2o = def.manyToOne || [];

    var lookupInfoByAttr = {};
    m2o.forEach(function(rel){
      var key = rel.ReferencingAttribute;
      var arr = lookupInfoByAttr[key] || [];
      arr.push({
        nav: rel.ReferencingEntityNavigationPropertyName || key,
        target: rel.ReferencedEntity
      });
      lookupInfoByAttr[key] = arr;
    });

    var promises = [];
    attrs.forEach(function(a){
      var name = a.LogicalName;
      if(name === 'statecode' || name === 'statuscode') return; // dejar por defecto

      if(a.AttributeType === 'Lookup' || a.AttributeType === 'Customer'){
        var idProp = '_' + name + '_value';
        var refId = record && record[idProp];
        if(refId){
          var logicalAnn = name + '@Microsoft.Dynamics.CRM.lookuplogicalname';
          var targetLogicalFromAnn = record && record[logicalAnn];
          var infos = lookupInfoByAttr[name] || [];
          var chosen = null;
          if(targetLogicalFromAnn){
            for(var k=0;k<infos.length;k++){
              if(infos[k].target === targetLogicalFromAnn){ chosen = infos[k]; break; }
            }
          }
          if(!chosen && infos.length){ chosen = infos[0]; }
          var navProp = chosen ? chosen.nav : name;
          var targetLogical = chosen ? chosen.target : targetLogicalFromAnn;
          if(targetLogical){
            promises.push(getTargetSetName(targetLogical).then(function(setName){
              payload[navProp+'@odata.bind'] = '/' + setName + '(' + refId + ')';
            }));
          }
        }
      } else {
        if(record && Object.prototype.hasOwnProperty.call(record, name)){
          payload[name] = record[name];
        }
      }
    });

    return Promise.all(promises).then(function(){ return payload; });
  }

  // Recupera todos los registros de una entidad con paginación simple
  function retrieveAll(entityLogicalName, query){
    var results = [];
    function page(nextLink){
      var q = nextLink ? nextLink : query;
      return Xrm.WebApi.retrieveMultipleRecords(entityLogicalName, q).then(function(res){
        results = results.concat(res.entities || []);
        if(res.nextLink){ return page(res.nextLink); }
        return results;
      });
    }
    return page(query);
  }

  // Crea registros tolerando propiedades desconocidas: si el servidor devuelve
  // "An undeclared property 'X'..." o "Could not find a property named 'X'...",
  // elimina 'X' y sus anotaciones (@odata.bind, @...) del payload y reintenta.
  function parseBadPropertyFromMessage(msg){
    if(!msg) return null;
    var m = msg.match(/undeclared property '([^']+)'/i);
    if(m && m[1]) return m[1];
    m = msg.match(/Could not find a property named '([^']+)'/i);
    if(m && m[1]) return m[1];
    return null;
  }

  function stripPropertyAndAnnotations(payload, prop){
    if(!prop) return;
    var keys = Object.keys(payload||{});
    keys.forEach(function(k){
      if(k === prop || k.indexOf(prop + '@') === 0){
        delete payload[k];
      }
    });
  }

  function createRecordTolerant(logicalName, payload, maxRetries){
    var retries = 0;
    var limit = (typeof maxRetries === 'number' ? maxRetries : 2);
    function attempt(){
      return Xrm.WebApi.createRecord(logicalName, payload).catch(function(err){
        var msg = (err && err.message) || '';
        var badProp = parseBadPropertyFromMessage(msg);
        if(badProp && retries < limit){
          retries++;
          stripPropertyAndAnnotations(payload, badProp);
          return attempt();
        }
        throw err;
      });
    }
    return attempt();
  }

  // Clona hijos 1:N de forma recursiva
  function cloneChildrenRecursively(parentLogical, parentOldId, parentNewId, visited){
    visited = visited || {};
    return getEntityDefinition(parentLogical).then(function(def){
      var rels = (def.oneToMany || []).filter(function(r){ return r.ReferencedEntity === parentLogical; });
      // Si hay lista blanca, limitar a esas entidades
      if(CONFIG && CONFIG.childWhitelist){
        rels = rels.filter(function(r){ return !!CONFIG.childWhitelist[r.ReferencingEntity]; });
      }
      var chain = Promise.resolve();
      rels.forEach(function(rel){
        chain = chain.then(function(){
          var childLogical = rel.ReferencingEntity;
          var childAttr = rel.ReferencingAttribute; // lookup en hijo hacia el padre
          // Evitar relaciones internas o ambiguas
          var skipEntities = { workflowlog: true, asyncoperation: true, processsession: true, bulkdeletefailure: true };
          var skipAttrs = { ownerid: true, owningbusinessunit: true, owninguser: true, owningteam: true };
          if(skipEntities[childLogical] || skipAttrs[childAttr]){ return Promise.resolve(); }
          return getEntityDefinition(childLogical).then(function(childDef){
            var selectList = buildSelectList(childDef.attributes, [childDef.primaryIdAttr].filter(Boolean));
            var filterProp = '_' + childAttr + '_value';
            var query = "?$select=" + selectList + "&$filter=" + filterProp + " eq " + parentOldId;
            return retrieveAll(childLogical, query).catch(function(err){
              var msg = (err && err.message) || '';
              if(/property named/i.test(msg)){
                var qNoSelect = "?$filter=" + filterProp + " eq " + parentOldId;
                return retrieveAll(childLogical, qNoSelect);
              }
              throw err;
            }).then(function(rows){
              var p = Promise.resolve();
              rows.forEach(function(row){
                p = p.then(function(){
                  return buildCreatePayload(childLogical, childDef, row).then(function(payload){
                    // Re-vincular al nuevo padre
                    return getTargetSetName(parentLogical).then(function(parentSet){
                      var navPropChildToParent = rel.ReferencingEntityNavigationPropertyName || childAttr;
                      payload[navPropChildToParent+'@odata.bind'] = '/' + parentSet + '(' + parentNewId + ')';
                      return createRecordTolerant(childLogical, payload).then(function(createRes){
                        var newChildId = createRes.id;
                        var oldChildId = row[childDef.primaryIdAttr];
                        // Recursividad: clonar descendencia del hijo
                        if(oldChildId){
                          return cloneChildrenRecursively(childLogical, oldChildId, newChildId, visited);
                        }
                        return Promise.resolve();
                      });
                    });
                  });
                });
              });
              return p;
            });
          });
        });
      });
      return chain;
    });
  }

  // Obtiene una selección de fila desde el Home Grid
  function getSelectedIdFromGrid(primaryControl, selectedIds){
    try{
      // 1) Si el diseñador de comandos nos pasó los IDs seleccionados
      if(Array.isArray(selectedIds) && selectedIds.length){
        if(selectedIds.length !== 1) return { error: 'Selecciona exactamente 1 campaña.' };
        return { id: Api.stripGuid(selectedIds[0]) };
      }

      // 2) Fallback: intentar obtener desde el grid (PrimaryControl)
      if(primaryControl && primaryControl.getGrid){
        var grid = primaryControl.getGrid();
        var sel = grid && grid.getSelectedRows ? grid.getSelectedRows() : null;
        if(sel){
          var count = sel.getCount();
          if(count !== 1) return { error: 'Selecciona exactamente 1 campaña.' };
          var row = sel.get(0);
          var id = row && row.getData && row.getData().entity.getId();
          return { id: Api.stripGuid(id) };
        }
      }
    }catch(e){}
    return { error: 'No fue posible obtener la selección del grid.' };
  }

  // Punto de entrada invocado por el botón de comando
  window.EjecutarFlujoDesdeBoton = function(primaryControl, selectedControlSelectedItemIds){
    Api.showProgress('Preparando clonación de campaña...');
    var sel = getSelectedIdFromGrid(primaryControl, selectedControlSelectedItemIds);
    if(sel.error){ Api.hideProgress(); Api.alert(sel.error); return; }

    var oldId = sel.id;
    Api.confirm('¿Deseas clonar la campaña seleccionada y todos sus registros relacionados?').then(function(ok){
      if(!ok){ Api.hideProgress(); return; }

      getEntityDefinition(ENTITY_CAMPAÑA).then(function(def){
        // Lectura sin $select para evitar errores por columnas no direccionables
        return Xrm.WebApi.retrieveRecord(ENTITY_CAMPAÑA, oldId).then(function(rec){
          return buildCreatePayload(ENTITY_CAMPAÑA, def, rec).then(function(payload){
            return createRecordTolerant(ENTITY_CAMPAÑA, payload).then(function(createRes){
              var newId = createRes.id;
              // Añadir sufijo " CLO" al ID Campaña autogenerado
              return Xrm.WebApi.retrieveRecord(ENTITY_CAMPAÑA, newId, "?$select=tema_litogl_tp_cp_idcampania").then(function(nuevo){
                var codigo = nuevo && nuevo["tema_litogl_tp_cp_idcampania"];
                var actualizado = (codigo ? (codigo + ' CLO') : null);
                var promUpdate = actualizado
                  ? Xrm.WebApi.updateRecord(ENTITY_CAMPAÑA, newId, { "tema_litogl_tp_cp_idcampania": actualizado })
                  : Promise.resolve();
                return promUpdate.then(function(){
                  return cloneChildrenRecursively(ENTITY_CAMPAÑA, oldId, newId, {}).then(function(){
                    Api.hideProgress();
                    // Refrescar el grid para que se vea la campaña clonada de inmediato
                    Api.refreshGrid(primaryControl);
                    Api.alert('✅ Clonación completada. Se creó una nueva campaña y sus registros relacionados fueron duplicados.');
                  });
                });
              });
            });
          });
        });
      }).catch(function(err){
        Api.hideProgress();
        var msg = (err && err.message ? err.message : err);
        if(/EntityDefinitions/i.test(msg)){
          msg = 'Fallo al consultar metadatos (EntityDefinitions). Verifica permisos de personalización o vuelve a publicar el recurso.';
        }
        Api.alert('Error en clonación: ' + msg);
      });
    });
  };

})();